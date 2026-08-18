import type { Server as NodeHttpServer } from 'node:http';
import { join } from 'node:path';
import { PLATFORM_POLICY } from '@280/contracts/platform-config';
import { serve } from '@hono/node-server';
import { Server } from './api.js';
import { Platform } from './deploysvc.js';
import { ContainerDeploymentCoordinator } from './activator.js';
import { buildContainerServices, buildAuth, buildIntegrations, sweepExpired } from './deps.js';
import { resolveConfig, type Config, type RequestDeps } from './config.js';
import { CloudflareLogSource } from './logsource.js';
import { open as openStore } from './store/index.js';
import { open as openFsBlobStore, openS3, type S3Config } from './blobstore/index.js';
import { newLogger } from './logger.js';
import type { BlobStore, Store } from './seams.js';
import type { Logger } from './observe.js';
import { EnvelopeSecretCipher, LocalKeyWrapper, type SecretCipher } from './secrets.js';
import { KmsKeyWrapper } from './kms.js';

export async function main(): Promise<void> {
  const log = newLogger(process.stdout.isTTY ? 'text' : 'json');
  try {
    await run(log);
  } catch (err) {
    log.error('fatal', { error: errText(err) });
    process.exitCode = 1;
  }
}

async function run(log: Logger): Promise<void> {
  const config = resolveConfig(process.env, process.env.DATABASE_URL ?? '');
  const secretCipher = buildSecretCipher(config, log);

  // open() boot-migrates with idempotent DDL, so the container and rollback paths
  // do not depend on the CI migrate runner having gone first.
  const store = await openStore(config.dbConnectionString, config.dbSchema);
  const blobs = await openBlobs(config, log);
  const { builder, configDelivery } = buildContainerServices(config, log, store, secretCipher);
  const activator = new ContainerDeploymentCoordinator({
    store,
    blobs,
    builder,
    config: configDelivery,
  });

  // Reads container logs from Cloudflare Workers Observability. buildContainerServices
  // already asserted the Cloudflare deploy credentials are present, so the same pair
  // backs the log source; unset would leave logs unconfigured (a clear endpoint error).
  const logs =
    config.cloudflare.accountId !== '' && config.cloudflare.apiToken !== ''
      ? new CloudflareLogSource({
          accountId: config.cloudflare.accountId,
          apiToken: config.cloudflare.apiToken,
        })
      : undefined;

  const platform = new Platform({
    store,
    blobs,
    activator,
    logs,
    appDomain: config.appDomain,
    hostSuffix: config.hostSuffix,
    frontendOrigin: config.dashboardOrigin,
  });

  const auth = buildAuth(store, config, log);
  const integrations = buildIntegrations(store, config, log, secretCipher);

  // One container reused for every request: the store is a process-lifetime pool,
  // torn down once at shutdown rather than per request.
  const deps: RequestDeps = {
    platform,
    auth,
    verificationUri: config.activationUrl,
    minCliVersion: config.minCliVersion,
    machineTokenTtlSecs: config.machineTokenTtlDays * 24 * 60 * 60,
    appDomain: config.appDomain,
    viewAsOrigin: config.authOrigin,
    secretCipher,
    integrations,
  };

  const app = new Server({ buildDeps: () => deps, logger: log }).handler();

  const addr = listenAddr();
  const sweep = startSweep(store, config, log);

  await new Promise<void>((resolve, reject) => {
    const node = serve({ fetch: app.fetch, hostname: addr.host, port: addr.port }, () => {
      log.info('280 platform listening', { addr: display(addr), appDomain: platform.appDomain });
    }) as unknown as NodeHttpServer;

    // Activation runs inside the request that lands the last blob, so the request
    // timeout has to cover a full runtime deploy.
    node.requestTimeout = 6 * 60 * 1000;
    node.headersTimeout = 20 * 1000;

    node.on('error', reject);

    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      log.info('shutting down');
      clearInterval(sweep);
      node.close((err) => {
        void store.close().finally(() => (err ? reject(err) : resolve()));
      });
      // Force resolution if connections linger past the grace window.
      setTimeout(() => void store.close().finally(() => resolve()), 30 * 1000).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

// buildSecretCipher picks the data-key wrapper: Cloud KMS (production design),
// the local AES key (dev loop / self-host), or none (read-only secret storage).
// Both configured at once is a startup error so production can never silently
// fall back to the local key.
function buildSecretCipher(config: Config, log: Logger): SecretCipher | undefined {
  const enc = config.secretEncryption;
  const kmsPartial = (enc.kmsKeyName === '') !== (enc.kmsCredentialsJson === '');
  if (kmsPartial) {
    throw new Error('incomplete KMS config: set both APP_SECRET_KMS_KEY_NAME and APP_SECRET_KMS_CREDENTIALS_JSON');
  }
  if (enc.kmsKeyName !== '' && enc.localKey !== '') {
    throw new Error('set APP_SECRET_KMS_* or APP_SECRET_LOCAL_MASTER_KEY, not both');
  }
  if (enc.kmsKeyName !== '') {
    log.info('secret encryption via Cloud KMS', { keyName: enc.kmsKeyName });
    return new EnvelopeSecretCipher(new KmsKeyWrapper(enc.kmsKeyName, enc.kmsCredentialsJson));
  }
  if (enc.localKey !== '') {
    log.info('secret encryption via local master key');
    return new EnvelopeSecretCipher(new LocalKeyWrapper(enc.localKey, enc.localKeyId));
  }
  log.warn('secret storage is read-only until APP_SECRET_KMS_* or APP_SECRET_LOCAL_MASTER_KEY is set');
  return undefined;
}

// startSweep runs the cleanup sweep on an interval, the Node stand-in for the
// Worker's cron trigger. Unref'd so it never keeps the process alive on its own.
function startSweep(store: Store, config: Config, log: Logger): NodeJS.Timeout {
  const machineTokenTtlSecs = config.machineTokenTtlDays * 24 * 60 * 60;
  const tick = () => {
    void sweepExpired(store, log, Math.floor(Date.now() / 1000), machineTokenTtlSecs, config.dashboardOrigin).catch((err) => {
      log.error('scheduled cleanup failed', { error: errText(err) });
    });
  };
  const timer = setInterval(tick, PLATFORM_POLICY.sweepIntervalSecs * 1000);
  timer.unref();
  return timer;
}

// openBlobs picks the blob backing: R2 over its S3 API when the S3 vars are set
// (the production path), else a local filesystem store for the dev loop. A partial
// S3 config is a startup failure rather than a silent fall-through to local disk.
async function openBlobs(config: Config, log: Logger): Promise<BlobStore> {
  const s3 = readS3Config();
  if (s3 !== null) {
    log.info('blobs=s3', { bucket: s3.bucket, endpoint: s3.endpoint });
    return openS3(s3);
  }
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'blobs')
    : 'data/blobs';
  log.warn('blobs=filesystem: set BLOB_S3_* for R2', { dir });
  return openFsBlobStore(dir);
}

// readS3Config returns the S3 backing config when the four required vars are all
// present, null when none are (dev loop), and throws when only some are (misconfig
// that would otherwise fail confusingly on the first push).
function readS3Config(): S3Config | null {
  const endpoint = process.env.BLOB_S3_ENDPOINT ?? '';
  const bucket = process.env.BLOB_S3_BUCKET ?? '';
  const accessKeyId = process.env.BLOB_S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.BLOB_S3_SECRET_ACCESS_KEY ?? '';
  const present = [endpoint, bucket, accessKeyId, secretAccessKey].filter((v) => v !== '');
  if (present.length === 0) return null;
  if (present.length < 4) {
    throw new Error(
      'incomplete S3 blob config: set all of BLOB_S3_ENDPOINT, BLOB_S3_BUCKET, BLOB_S3_ACCESS_KEY_ID, BLOB_S3_SECRET_ACCESS_KEY (or none for the local filesystem store)',
    );
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.BLOB_S3_REGION || 'auto',
    forcePathStyle: (process.env.BLOB_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
  };
}

interface Addr {
  host: string;
  port: number;
}

// Railway supplies PORT. Local processes use the image's fixed port.
function listenAddr(): Addr {
  return { host: '0.0.0.0', port: Number(process.env.PORT) || 8080 };
}

function display(a: Addr): string {
  return `${a.host}:${a.port}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run when invoked as the entrypoint, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

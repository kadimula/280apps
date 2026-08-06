// The Node entrypoint for the 280 control plane: serves HTTP API v1, activates
// deploys inline, and sweeps expired rows on an interval. This is the host the
// package ships as on Railway (packages/backend/Dockerfile), and the only one.
// Everything I/O is a process-lifetime singleton here — one pg pool, one blob
// store, one runtime, one in-process activator — assembled once at boot.

import type { Server as NodeHttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Server } from './api.js';
import { Platform } from './deploysvc.js';
import { InProcessActivator } from './activator.js';
import { selectRuntime, buildAuth, sweepExpired } from './deps.js';
import { resolveConfig, type Config, type RequestDeps } from './config.js';
import { open as openStore } from './store/index.js';
import { open as openFsBlobStore, openS3, type S3Config } from './blobstore/index.js';
import { newLogger } from './logger.js';
import type { BlobStore, Store } from './seams.js';
import type { Logger } from './observe.js';
import { EnvelopeSecretCipher, LocalKeyWrapper, type SecretCipher } from './secrets.js';
import { KmsKeyWrapper } from './kms.js';

export async function main(): Promise<void> {
  const log = newLogger(process.env.TWO80_LOG_FORMAT === 'json' ? 'json' : 'text');
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
  const { runtime, secretDelivery } = selectRuntime(config, log, store, secretCipher);

  // One in-process activator serializes an app's activation and delete by a
  // promise chain: the single-instance replacement for the per-app Durable Object.
  // Activation runs inline in the request that lands the last blob, which is why
  // the request timeout below is sized to a full runtime deploy.
  const activator = new InProcessActivator({ store, blobs, runtime });

  const platform = new Platform({
    store,
    blobs,
    activator,
    appDomain: config.appDomain,
    hostSuffix: config.hostSuffix,
    frontendOrigin: config.frontendOrigin,
  });

  const auth = buildAuth(store, config, log);

  // One container reused for every request: the store is a process-lifetime pool,
  // torn down once at shutdown rather than per request.
  const deps: RequestDeps = {
    platform,
    auth,
    verificationUri: config.verificationUri,
    minCliVersion: config.minCliVersion,
    machineTokenTtlSecs: config.machineTokenTtlDays * 24 * 60 * 60,
    appDomain: config.appDomain,
    viewAsOrigin: `https://auth.${config.appDomain}`,
    secretCipher,
    secretDelivery,
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
    throw new Error('incomplete KMS config: set both TWO80_SECRET_KMS_KEY_NAME and TWO80_SECRET_KMS_CREDENTIALS_JSON');
  }
  if (enc.kmsKeyName !== '' && enc.localKey !== '') {
    throw new Error('set TWO80_SECRET_KMS_* or TWO80_SECRET_ENCRYPTION_KEY, not both');
  }
  if (enc.kmsKeyName !== '') {
    log.info('secret encryption via Cloud KMS', { keyName: enc.kmsKeyName });
    return new EnvelopeSecretCipher(new KmsKeyWrapper(enc.kmsKeyName, enc.kmsCredentialsJson));
  }
  if (enc.localKey !== '') {
    log.info('secret encryption via local master key');
    return new EnvelopeSecretCipher(new LocalKeyWrapper(enc.localKey, enc.localKeyId));
  }
  log.warn('secret storage is read-only until TWO80_SECRET_KMS_* or TWO80_SECRET_ENCRYPTION_KEY is set');
  return undefined;
}

// startSweep runs the cleanup sweep on an interval, the Node stand-in for the
// Worker's cron trigger. Unref'd so it never keeps the process alive on its own.
function startSweep(store: Store, config: Config, log: Logger): NodeJS.Timeout {
  const secs = num(process.env.TWO80_SWEEP_INTERVAL_SECS, 60);
  const machineTokenTtlSecs = config.machineTokenTtlDays * 24 * 60 * 60;
  const tick = () => {
    void sweepExpired(store, log, Math.floor(Date.now() / 1000), machineTokenTtlSecs, config.frontendOrigin).catch((err) => {
      log.error('scheduled cleanup failed', { error: errText(err) });
    });
  };
  const timer = setInterval(tick, secs * 1000);
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
  const dir = env('TWO80_BLOBS', 'data/blobs');
  log.warn('blobs=filesystem: local-only and not durable across hosts; set TWO80_S3_* for R2', { dir });
  return openFsBlobStore(dir);
}

// readS3Config returns the S3 backing config when the four required vars are all
// present, null when none are (dev loop), and throws when only some are (misconfig
// that would otherwise fail confusingly on the first push).
function readS3Config(): S3Config | null {
  const endpoint = process.env.TWO80_S3_ENDPOINT ?? '';
  const bucket = process.env.TWO80_S3_BUCKET ?? '';
  const accessKeyId = process.env.TWO80_S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.TWO80_S3_SECRET_ACCESS_KEY ?? '';
  const present = [endpoint, bucket, accessKeyId, secretAccessKey].filter((v) => v !== '');
  if (present.length === 0) return null;
  if (present.length < 4) {
    throw new Error(
      'incomplete S3 blob config: set all of TWO80_S3_ENDPOINT, TWO80_S3_BUCKET, TWO80_S3_ACCESS_KEY_ID, TWO80_S3_SECRET_ACCESS_KEY (or none for the local filesystem store)',
    );
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env('TWO80_S3_REGION', 'auto'),
    forcePathStyle: (process.env.TWO80_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
  };
}

interface Addr {
  host: string;
  port: number;
}

// listenAddr honors PORT, which is how every container host (Railway included) says
// where to listen. TWO80_ADDR stays for the local loop, where binding an interface
// matters more than a port.
function listenAddr(): Addr {
  const p = process.env.PORT;
  if (p) return { host: '0.0.0.0', port: Number(p) };
  return parseAddr(env('TWO80_ADDR', ':8080'));
}

function parseAddr(s: string): Addr {
  const i = s.lastIndexOf(':');
  const host = i > 0 ? s.slice(0, i) : '0.0.0.0';
  const port = Number(s.slice(i + 1));
  return { host, port };
}

function display(a: Addr): string {
  return `${a.host}:${a.port}`;
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

function num(v: string | undefined, fallback: number): number {
  return Number(v !== undefined && v !== '' ? v : String(fallback)) || fallback;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run when invoked as the entrypoint, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

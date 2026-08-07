// The shared spine of every builder that pushes to registry.cloudflare.com and
// rolls the app's container application with wrangler. It owns the parts that are
// identical no matter how the image is compiled: materializing the uploaded build
// context, the wrangler roll, teardown, image naming, and the exec discipline that
// turns a non-zero exit into an agent-actionable DeployErr.
//
// The one step that differs per build home — how the image is actually built and
// pushed — is the single abstract method buildAndPush. DepotBuilder implements it
// with one `depot build --push`. Keeping the shared sequence here is what lets a
// new build home add only buildAndPush: a fix to the roll (see rollContainerApp)
// or teardown lands for every builder at once.
//
// Every external command goes through an injected ExecFn, so the whole sequence is
// unit-testable without Docker, Depot, or a Cloudflare account. This module reaches
// for node:fs and node:child_process and must NEVER enter a Workers bundle; it is
// imported only by the node builders and their tests, never re-exported from index.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DeployCode, DeployErr } from '@280/contracts';
import type { RuntimeApp } from '../../seams.js';
import type { Logger } from '../../observe.js';
import type { ContainerBuilder, RolloutJob, RolloutResult } from './container.js';
import { deliveryFailed, type WorkerSecretStore } from '../../secret-delivery.js';

export interface ExecResult {
  code: number;
  output: string; // combined stdout + stderr
}

// ExecFn runs one command in cwd and resolves with its exit code and combined
// output. It never rejects on a non-zero exit; the builder inspects code. env is
// merged over the process environment. input is written only to stdin and is used
// for Worker secret delivery so values never enter argv or a file.
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; input?: string },
) => Promise<ExecResult>;

// The container class and binding the app's Worker declares; mirrors
// platform/appcontainer/wrangler.jsonc, the harness every 280 app runs in.
const CONTAINER_CLASS = 'App280Container';
const CONTAINER_BINDING = 'APP';
const DEFAULT_REGISTRY = 'registry.cloudflare.com';
const DEFAULT_COMPAT_DATE = '2026-06-01';
const ROLL_CONFIG_FILE = 'wrangler.roll.json';
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const REGISTRY_CRED_TTL_MINUTES = 60;
const SECRET_BULK_LIMIT = 100;

const DEFAULT_APP_DOMAIN = '280apps.run';
// The service binding every app Worker declares to the central identity gateway,
// and the RPC class it targets (GatewayRPC.mint/jwks). Binding-only: the mint
// decision is never a public HTTP path.
const GATEWAY_BINDING = 'GATEWAY';
const GATEWAY_ENTRYPOINT = 'GatewayRPC';
// The tight edge-verify skew baked into each app Worker: with the 30s mint TTL it
// bounds revocation to ~35s while absorbing benign edge clock jitter (design §1).
const EDGE_SKEW_SECS = '5';

export interface RegistryBuilderConfig {
  accountId: string;
  apiToken: string;
  registry?: string; // default registry.cloudflare.com
  instanceType?: string; // default 'dev'
  maxInstances?: number; // default 1
  workdir?: string; // where contexts materialize; default os.tmpdir()
  // workerEntry is the App280Container harness Worker the generated roll config
  // points `main` at. It is supplied by the runtime image (the harness is vendored
  // beside the control plane), not the app's own source. Defaulted so the shape is
  // explicit; the live roll needs the file to exist, unit tests do not.
  workerEntry?: string;
  compatibilityDate?: string; // default DEFAULT_COMPAT_DATE
  // The serving topology the roll bakes into each per-app Worker (design §5):
  //   appDomain      the zone app hosts live on (route zone_name); default 280apps.run
  //   hostSuffix     '' in prod, '-development' in dev; the app host is
  //                  <script><hostSuffix>.<appDomain>
  //   gatewayService the central gateway Worker the GATEWAY binding targets; default
  //                  280-gateway<hostSuffix>
  //   idIssuer       the token issuer the middleware checks; default
  //                  https://auth<hostSuffix>.<appDomain>
  appDomain?: string;
  hostSuffix?: string;
  gatewayService?: string;
  idIssuer?: string;
  // frameAncestors is the space-separated CSP frame-ancestors allowlist baked into
  // each app Worker (TWO80_FRAME_ANCESTORS): the dashboard origin(s) allowed to embed
  // an app host. Defaulted to the prod console so the shape is explicit.
  frameAncestors?: string;
  exec?: ExecFn;
  // fetch talks to the Cloudflare API to mint registry credentials; injected so the
  // credential exchange is unit-testable without a Cloudflare account.
  fetch?: typeof fetch;
  // log receives teardown's best-effort image-cleanup warnings; defaults to a no-op.
  log?: Logger;
}

// RegistryContainerBuilder materializes and pushes an image in build(), then rolls
// that image independently in rollout(). Subclasses supply only buildAndPush.
export abstract class RegistryContainerBuilder implements ContainerBuilder, WorkerSecretStore {
  protected readonly accountId: string;
  protected readonly apiToken: string;
  protected readonly registry: string;
  protected readonly instanceType: string;
  protected readonly maxInstances: number;
  protected readonly workdir: string;
  protected readonly workerEntry: string;
  protected readonly compatibilityDate: string;
  protected readonly appDomain: string;
  protected readonly hostSuffix: string;
  protected readonly gatewayService: string;
  protected readonly idIssuer: string;
  protected readonly frameAncestors: string;
  protected readonly exec: ExecFn;
  protected readonly fetchImpl: typeof fetch;
  protected readonly log: Logger;

  constructor(cfg: RegistryBuilderConfig) {
    this.accountId = cfg.accountId;
    this.apiToken = cfg.apiToken;
    this.registry = cfg.registry ?? DEFAULT_REGISTRY;
    this.instanceType = cfg.instanceType ?? 'dev';
    this.maxInstances = cfg.maxInstances ?? 1;
    this.workdir = cfg.workdir ?? tmpdir();
    this.workerEntry = cfg.workerEntry ?? 'worker.js';
    this.compatibilityDate = cfg.compatibilityDate ?? DEFAULT_COMPAT_DATE;
    this.appDomain = cfg.appDomain ?? DEFAULT_APP_DOMAIN;
    this.hostSuffix = cfg.hostSuffix ?? '';
    this.gatewayService = cfg.gatewayService ?? `280-gateway${this.hostSuffix}`;
    this.idIssuer = cfg.idIssuer ?? `https://auth${this.hostSuffix}.${this.appDomain}`;
    this.frameAncestors = cfg.frameAncestors ?? 'https://console.280apps.com';
    this.exec = cfg.exec ?? spawnExec;
    this.fetchImpl = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.log = cfg.log ?? NOOP_LOG;
  }

  // registryCredentials mints a short-lived push/pull credential for the registry.
  // registry.cloudflare.com rejects the raw API token as a basic-auth password; the
  // token is only authorized to exchange it for these scoped, expiring creds.
  protected registryCredentials(): Promise<{ username: string; password: string }> {
    return mintRegistryCredentials(this.accountId, this.apiToken, this.registry, this.fetchImpl);
  }

  imageRef(app: RuntimeApp, deployId: string): string {
    return `${this.registry}/${this.accountId}/${app.script}:${deployId}`;
  }

  async build(job: RolloutJob): Promise<RolloutResult> {
    const ctx = await mkdtemp(join(this.workdir, '280-ctx-'));
    try {
      await materialize(ctx, job.files);
      const image = this.imageRef(job.app, job.deployId);
      await this.buildAndPush(ctx, image, job.build.dockerfile || 'Dockerfile', job);
      return { imageRef: image };
    } finally {
      await rm(ctx, { recursive: true, force: true });
    }
  }

  async rollout(job: RolloutJob, image: string): Promise<void> {
    const ctx = await mkdtemp(join(this.workdir, '280-roll-'));
    try {
      await this.roll(ctx, image, job);
    } finally {
      await rm(ctx, { recursive: true, force: true });
    }
  }

  // buildAndPush compiles the context in ctx into image and pushes it to the
  // registry. It is the only step that differs between build homes.
  protected abstract buildAndPush(
    ctx: string,
    image: string,
    dockerfile: string,
    job: RolloutJob,
  ): Promise<void>;

  // roll makes the app's container application serve the pre-built image, with no
  // local Docker build. The real wrangler path is `wrangler deploy` against a
  // generated config whose container `image` is the fully-qualified registry
  // reference; `--containers-rollout immediate` rolls every instance in one step.
  // (The old `wrangler containers apply` never existed in wrangler 4.116 — it
  // no-oped while the deploy reported success. See report §7.)
  protected async roll(ctx: string, image: string, job: RolloutJob): Promise<void> {
    const configPath = join(ctx, ROLL_CONFIG_FILE);
    await writeFile(configPath, JSON.stringify(this.rollConfig(job, image), null, 2));
    await this.run(
      ctx,
      'wrangler',
      ['deploy', '--config', ROLL_CONFIG_FILE, '--containers-rollout', 'immediate'],
      'roll the container application',
      { CLOUDFLARE_API_TOKEN: this.apiToken, CLOUDFLARE_ACCOUNT_ID: this.accountId },
    );
  }

  // rollConfig is the wrangler config the roll deploys: the App280Container harness
  // Worker, now the app's own front door on its own route. It is pinned to the
  // pre-built registry image (so wrangler reconciles the application without building
  // anything) and additionally carries, per app:
  //   - routes:   its own <script><suffix>.<appDomain>/* host, more specific than the
  //               legacy wildcard so it wins during migration.
  //   - services: the GATEWAY service binding to the central gateway's GatewayRPC
  //               (mint/jwks), the only channel the middleware uses.
  //   - vars:     the baked route policy plus the identity vars the middleware reads
  //               (app id/script, host suffix/domain, issuer, edge skew).
  protected rollConfig(job: RolloutJob, image: string): Record<string, unknown> {
    const script = job.app.script;
    const host = `${script}${this.hostSuffix}.${this.appDomain}`;
    return {
      name: script,
      main: this.workerEntry,
      compatibility_date: this.compatibilityDate,
      compatibility_flags: ['nodejs_compat'],
      routes: [{ pattern: `${host}/*`, zone_name: this.appDomain }],
      services: [{ binding: GATEWAY_BINDING, service: this.gatewayService, entrypoint: GATEWAY_ENTRYPOINT }],
      durable_objects: {
        bindings: [{ class_name: CONTAINER_CLASS, name: CONTAINER_BINDING }],
      },
      containers: [
        {
          class_name: CONTAINER_CLASS,
          image,
          instance_type: this.instanceType,
          max_instances: this.maxInstances,
        },
      ],
      migrations: [{ tag: 'v1', new_sqlite_classes: [CONTAINER_CLASS] }],
      vars: {
        TWO80_ROUTE_POLICY: JSON.stringify(job.policy),
        TWO80_APP_ID: job.app.id,
        TWO80_SCRIPT: script,
        TWO80_APP_HOST_SUFFIX: this.hostSuffix,
        TWO80_APP_DOMAIN: this.appDomain,
        TWO80_ID_ISSUER: this.idIssuer,
        TWO80_ID_SKEW_SECS: EDGE_SKEW_SECS,
        TWO80_FRAME_ANCESTORS: this.frameAncestors,
      },
    };
  }

  async bulk(app: RuntimeApp, values: Record<string, string | null>): Promise<void> {
    const entries = Object.entries(values);
    for (let offset = 0; offset < entries.length; offset += SECRET_BULK_LIMIT) {
      const batch = Object.fromEntries(entries.slice(offset, offset + SECRET_BULK_LIMIT));
      const names = Object.keys(batch);
      const res = await this.exec('wrangler', ['secret', 'bulk', '--name', app.script], {
        cwd: this.workdir,
        env: { CLOUDFLARE_API_TOKEN: this.apiToken, CLOUDFLARE_ACCOUNT_ID: this.accountId },
        input: JSON.stringify(batch),
      });
      if (res.code !== 0) throw deliveryFailed(names);
    }
  }

  async teardown(app: RuntimeApp): Promise<void> {
    // Teardown is the exact inverse of the roll: roll() runs `wrangler deploy` for a
    // Worker named app.script (rollConfig.name), so teardown deletes that Worker with
    // `wrangler delete <script>`. Removing the Worker takes its route down (the app
    // stops serving) and drops the Durable Object the container application is bound
    // to. --force skips the interactive confirm (there is no TTY here) and deletes
    // even if something depends on it.
    //
    // NB: `wrangler containers delete` is NOT this command — it takes a container ID,
    // not a script name, and rejects --force; passing the script name there is what
    // made every teardown fail ("Unknown argument: force").
    //
    // Idempotent: a Worker already gone is success. wrangler exits non-zero for a
    // missing script, so a not-found message is treated as done; anything else is a
    // retryable failure the alarm re-runs.
    const res = await this.exec('wrangler', ['delete', app.script, '--force'], {
      cwd: this.workdir,
      env: { CLOUDFLARE_API_TOKEN: this.apiToken, CLOUDFLARE_ACCOUNT_ID: this.accountId },
    });
    if (
      res.code !== 0 &&
      !/not found|does not exist|could ?n'?t find|script_not_found|service_not_found/i.test(res.output)
    ) {
      throw new DeployErr({
        code: DeployCode.Unavailable,
        message: `could not delete app worker ${app.script}: ${tail(res.output)}`,
        retryable: true,
      });
    }

    // Then reap the app's registry tags (one per historical deploy). Best-effort: this
    // runs before store.deleteApp, so a throw would strand the app row — leftover tags
    // are only storage, so a failure is logged and swallowed, not retried.
    await this.deleteImages(app);
  }

  // deleteImages removes every registry tag under the app's repository (<script>). It
  // never throws, so image cleanup can never block the rest of teardown.
  private async deleteImages(app: RuntimeApp): Promise<void> {
    const env = { CLOUDFLARE_API_TOKEN: this.apiToken, CLOUDFLARE_ACCOUNT_ID: this.accountId };
    const listed = await this.exec(
      'wrangler',
      ['containers', 'images', 'list', '--json', '--filter', app.script],
      { cwd: this.workdir, env },
    );
    if (listed.code !== 0) {
      // A gone repo lists as [] with exit 0, so a non-zero exit is a real failure.
      this.log.warn('image cleanup: could not list app images', {
        script: app.script,
        output: tail(listed.output),
      });
      return;
    }
    // --filter is a regex, so match the exact repository by name before deleting.
    const tags = imageTags(listed.output, app.script);
    for (const tag of tags) {
      const ref = `${app.script}:${tag}`;
      const del = await this.exec('wrangler', ['containers', 'images', 'delete', ref, '-y'], {
        cwd: this.workdir,
        env,
      });
      // A tag already gone (404) is success; anything else is warned and left behind.
      if (del.code !== 0 && !/not found|does not exist|404/i.test(del.output)) {
        this.log.warn('image cleanup: could not delete app image tag', {
          image: ref,
          output: tail(del.output),
        });
      }
    }
  }

  // run executes a build/roll step and turns a non-zero exit into the seam's
  // agent-actionable throwable. A build failure is the app's own (its
  // Dockerfile/build): surface the log tail and a fix, non-retryable, so the agent
  // repairs it rather than the loop retrying identical bytes. Because a non-zero
  // exit throws, a step that shells out to a command that does not exist can no
  // longer masquerade as success the way `wrangler containers apply` did.
  protected async run(
    cwd: string,
    cmd: string,
    args: string[],
    what: string,
    env?: Record<string, string>,
  ): Promise<void> {
    const res = await this.exec(cmd, args, env ? { cwd, env } : { cwd });
    if (res.code === 0) return;
    throw new DeployErr({
      code: DeployCode.Unavailable,
      message: `failed to ${what}:\n${tail(res.output)}`,
      fix: 'fix the build error above, then run two80 push again',
      retryable: false,
    });
  }
}

// materialize writes the build context to dir, creating parent directories and
// refusing any path that escapes the context root (defence in depth: preflight
// already rejected these, but the builder never trusts the manifest with a raw
// filesystem write).
export async function materialize(dir: string, files: RolloutJob['files']): Promise<void> {
  const root = resolve(dir);
  for (const f of files) {
    const abs = resolve(root, f.path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new DeployErr({
        code: DeployCode.PreflightRejected,
        message: `context path "${f.path}" escapes the build context`,
        fix: 'upgrade the two80 CLI, then run two80 push again',
      });
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, await f.read());
  }
}

// mintRegistryCredentials exchanges the Cloudflare API token for a short-lived
// basic-auth pair scoped to registry.cloudflare.com. The registry does not accept
// the raw API token (or the account id) as a password; it requires these minted
// credentials (username "v1", an expiring JWT). Both `docker login` and Depot's
// docker-config credentials provider consume the returned pair.
async function mintRegistryCredentials(
  accountId: string,
  apiToken: string,
  registry: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ username: string; password: string }> {
  const url = `${CF_API_BASE}/accounts/${accountId}/containers/registries/${registry}/credentials`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: ['push', 'pull'], expiration_minutes: REGISTRY_CRED_TTL_MINUTES }),
  });
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: { username?: string; password?: string } }
    | null;
  const username = body?.result?.username;
  const password = body?.result?.password;
  if (!res.ok || body?.success !== true || !username || !password) {
    throw new DeployErr({
      code: DeployCode.Unavailable,
      message: `could not obtain registry credentials from Cloudflare (HTTP ${res.status})`,
      retryable: true,
    });
  }
  return { username, password };
}

export function tail(s: string, n = 25): string {
  const lines = s.split('\n').filter((l) => l.trim() !== '');
  return (lines.length > n ? lines.slice(-n) : lines).join('\n');
}

// Logger sink for callers that inject none.
const NOOP_LOG: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// imageTags pulls the tags for exactly `script` out of `containers images list --json`
// (an array of { name, tags }). The JSON is sliced from first '[' to last ']' so a
// wrangler notice merged onto the stream (exec combines stdout+stderr) can't break the
// parse; any parse miss yields no tags, so cleanup deletes nothing rather than throwing.
export function imageTags(output: string, script: string): string[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end < start) return [];
  let repos: unknown;
  try {
    repos = JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(repos)) return [];
  const repo = repos.find(
    (r): r is { name: string; tags?: unknown } =>
      typeof r === 'object' && r !== null && (r as { name?: unknown }).name === script,
  );
  const tags = repo?.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

// spawnExec is the production ExecFn: it runs the command and collects combined
// output. child_process is imported lazily so this module loads under type-checking
// without pinning the import at module scope.
const spawnExec: ExecFn = async (cmd, args, opts) => {
  const { spawn } = await import('node:child_process');
  return new Promise<ExecResult>((resolveExec) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));
    child.stdin?.on('error', () => {});
    child.on('error', (e) => resolveExec({ code: 127, output: output + String(e) }));
    child.on('close', (code) => resolveExec({ code: code ?? 0, output }));
    child.stdin?.end(opts.input);
  });
};

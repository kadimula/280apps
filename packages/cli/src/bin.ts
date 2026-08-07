// bin is the composition root: the one place that binds the CLI's command surface
// (app.ts, side-effect-free) to the real world (process streams, working
// directory, git, the HTTP/fake Port adapters). tsup bundles this into
// dist/bin.js, the artifact the `two80` bin points at.

import { spawnSync } from 'node:child_process';
import type { Port } from '@280/contracts';
import { Client as DeployClient } from '@280/contracts/deploy/http';
import { Fake } from '@280/contracts/deploy/fake';
import { newClient as newAuthClient } from '@280/contracts/auth/http';
import { run, apiBase, VERSION, type Deps, type Env } from './app.js';
import { ensureToken, type AuthClient } from './login.js';
import { processStreams } from './output.js';
import { build as buildProject } from './bundle/index.js';
import type { Bundle } from './push.js';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// gitRemote returns origin's URL for fingerprint dedup, "" when none. Spawns git
// with no stdin so a prompt can never stall a push.
function gitRemote(root: string): string {
  const r = spawnSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return '';
  return r.stdout.trim();
}

// openPort builds the deploy adapter: the in-memory Fake when TWO80_FAKE=1, else
// the authed HTTP client (ensuring a device-login token first).
async function openPort(): Promise<Port> {
  if (process.env.TWO80_FAKE === '1') return new Fake();
  const api = apiBase();
  const token = await ensureToken(api, newAuthClient(api), nowSeconds());
  // X-280-Cli-Version lets the platform retire a CLI it can no longer talk to
  // (cli_too_old).
  return new DeployClient(api, { token, cliVersion: VERSION });
}

// buildBundle delegates to the bundler, which throws a PreflightError {code,
// message, fix} that app.run renders like any other failure.
async function buildBundle(root: string, framework: string): Promise<Bundle> {
  return buildProject(root, framework);
}

const deps: Deps = {
  buildBundle,
  openPort,
  authClient: (api) => newAuthClient(api) as AuthClient,
  gitRemote,
  now: nowSeconds,
};

const env: Env = {
  args: process.argv.slice(2),
  root: process.cwd(),
  streams: processStreams,
  binPath: process.argv[1] ?? process.execPath,
};

run(env, deps).then(
  (code) => process.exit(code),
  (err) => {
    // run() renders every command failure itself; reaching here is an unexpected
    // internal fault. Fail closed with exit 1 and a diagnostic.
    process.stderr.write(`two80: internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);

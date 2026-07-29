// Golden TOON stdout fixtures (plan §4.4). Hand-authored AXI output per §3a
// (NOT recorded from Go), committed under testdata/. Each scenario asserts:
//   - stdout byte-equals the committed fixture (version string normalized), and
//   - the exit code and, for errors, the {code, fix} match the Go behavior the
//     CLI mirrors (cli/internal/app/*.go). Those Go-derived expectations are
//     encoded inline as `check`.
// Regenerate with UPDATE_FIXTURES=1 (then review the diff), assert otherwise.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fake } from '@280/contracts/deploy/fake';
import * as config from '../src/config.js';
import * as credentials from '../src/credentials.js';
import { VERSION } from '../src/app.js';
import { parseToon, runCli, stubAuth, tmpHome, tmpProject, type RunResult } from './helpers.js';

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');
const API = 'https://api.280apps.com';
const UPDATE = process.env.UPDATE_FIXTURES === '1';
const VERSION_TOKEN = '<VERSION>';

function freshHome(): void {
  process.env.TWO80_HOME = tmpHome();
  delete process.env.TWO80_API;
}

function demoProject(): string {
  return tmpProject({ 'package.json': JSON.stringify({ name: 'demo' }), 'index.html': '<h1>hi</h1>' });
}

// normalize replaces the release version so fixtures survive a version bump.
function normalize(s: string): string {
  return s.split(VERSION).join(VERSION_TOKEN);
}

interface Scenario {
  name: string; // fixture file basename
  code: number; // expected exit code
  check?: { error?: string; fix?: string }; // Go-parity cross-check on {code, fix}
  run: () => Promise<RunResult>;
}

const scenarios: Scenario[] = [
  {
    name: 'version',
    code: 0,
    run: () => runCli(['--version'], { root: demoProject() }),
  },
  {
    name: 'help',
    code: 0,
    run: () => runCli(['help'], { root: demoProject() }),
  },
  {
    name: 'push-help',
    code: 0,
    run: () => runCli(['push', '--help'], { root: demoProject() }),
  },
  {
    name: 'init-help',
    code: 0,
    run: () => runCli(['init', '--help'], { root: demoProject() }),
  },
  {
    name: 'delete-help',
    code: 0,
    run: () => runCli(['delete', '--help'], { root: demoProject() }),
  },
  {
    name: 'whoami-help',
    code: 0,
    run: () => runCli(['whoami', '--help'], { root: demoProject() }),
  },
  {
    name: 'login-help',
    code: 0,
    run: () => runCli(['login', '--help'], { root: demoProject() }),
  },
  {
    name: 'init',
    code: 0,
    run: () => {
      freshHome();
      return runCli(['init'], { root: demoProject() });
    },
  },
  {
    name: 'push',
    code: 0,
    run: () => {
      freshHome();
      return runCli(['push'], { root: demoProject(), port: new Fake() });
    },
  },
  {
    name: 'home-empty',
    code: 0,
    run: () => {
      freshHome();
      return runCli([], { root: demoProject() });
    },
  },
  {
    name: 'home-deployed',
    code: 0,
    run: () => {
      freshHome();
      const root = demoProject();
      config.save(root, { name: 'demo', framework: 'static', appId: 'app_000001', clientRef: 'cr_x' });
      return runCli([], { root });
    },
  },
  {
    name: 'whoami-logged-in',
    code: 0,
    run: () => {
      freshHome();
      credentials.save({ token: 'tok', api: API });
      return runCli(['whoami'], { root: demoProject() });
    },
  },
  {
    name: 'login-success',
    code: 0,
    run: () => {
      freshHome();
      credentials.save({ token: 'tok', api: API });
      return runCli(['login'], { root: demoProject() });
    },
  },
  {
    name: 'delete-success',
    code: 0,
    run: async () => {
      freshHome();
      const root = demoProject();
      const fake = new Fake();
      await runCli(['push'], { root, port: fake });
      return runCli(['delete', '--yes', 'demo'], { root, port: fake });
    },
  },
  {
    name: 'whoami-logged-out',
    code: 0,
    run: () => {
      freshHome();
      return runCli(['whoami'], { root: demoProject(), auth: stubAuth({ api: API }) });
    },
  },
  {
    name: 'error-login-pending',
    code: 1,
    check: { error: 'authorization_pending' },
    run: () => {
      freshHome();
      return runCli(['login'], { root: demoProject(), auth: stubAuth({ api: API }), now: 1_000_000 });
    },
  },
  {
    name: 'error-delete-confirm-required',
    code: 1,
    check: { error: 'confirmation_required', fix: 'run 280 delete --yes demo' },
    run: async () => {
      freshHome();
      const root = demoProject();
      const fake = new Fake();
      await runCli(['push'], { root, port: fake });
      return runCli(['delete'], { root, port: fake });
    },
  },
  {
    name: 'delete-no-app',
    code: 0,
    run: () => {
      freshHome();
      return runCli(['delete'], { root: demoProject(), port: new Fake() });
    },
  },
  {
    name: 'error-unknown-command',
    code: 1,
    check: { error: 'unknown_command', fix: 'run 280 help' },
    run: () => runCli(['frobnicate'], { root: demoProject() }),
  },
  {
    name: 'error-not-implemented',
    code: 1,
    check: { error: 'not_implemented', fix: 'run 280 help for what works today' },
    run: () => runCli(['share'], { root: demoProject() }),
  },
  {
    name: 'error-unknown-flag',
    code: 2,
    check: { error: 'unknown_flag' },
    run: () => runCli(['push', '--stat'], { root: demoProject(), port: new Fake() }),
  },
  {
    name: 'error-removed-flag',
    code: 2,
    check: { error: 'removed_flag' },
    run: () => runCli(['push', '--json'], { root: demoProject(), port: new Fake() }),
  },
];

describe('golden TOON stdout fixtures (§4.4)', () => {
  for (const sc of scenarios) {
    it(`${sc.name}: matches fixture, exit ${sc.code}${sc.check ? `, {${sc.check.error}}` : ''}`, async () => {
      const r = await sc.run();
      expect(r.code, `exit code for ${sc.name}`).toBe(sc.code);

      if (sc.check) {
        const t = parseToon(r.out);
        if (sc.check.error !== undefined) expect(t.error, `error code for ${sc.name}`).toBe(sc.check.error);
        if (sc.check.fix !== undefined) expect(t.fix, `fix for ${sc.name}`).toBe(sc.check.fix);
      }

      const file = path.join(TESTDATA, `${sc.name}.toon`);
      const got = normalize(r.out);
      if (UPDATE) {
        fs.mkdirSync(TESTDATA, { recursive: true });
        fs.writeFileSync(file, got);
        return;
      }
      const want = fs.readFileSync(file, 'utf8');
      expect(got, `stdout for ${sc.name}`).toBe(want);
    });
  }
});

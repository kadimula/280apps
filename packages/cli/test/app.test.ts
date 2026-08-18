// Full command surface driven end to end through app.run with the Fake port:
// dispatch, exit codes, and the agent-facing {code, fix} per scenario.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Fake } from '@280/contracts/deploy/fake';
import type { DeployStatus } from '@280/contracts';
import * as config from '../src/config.js';
import * as credentials from '../src/credentials.js';
import { VERSION } from '../src/app.js';
import { build } from '../src/bundle/index.js';
import { parseToon, runCli, stubAuth, tmpHome, tmpProject } from './helpers.js';

const API = 'https://api.280apps.com';
const prev = process.env.TWO80_HOME;

beforeEach(() => {
  process.env.TWO80_HOME = tmpHome();
  delete process.env.TWO80_API;
});
afterEach(() => {
  if (prev === undefined) delete process.env.TWO80_HOME;
  else process.env.TWO80_HOME = prev;
});

describe('version and help', () => {
  it('--version prints the version, exit 0', async () => {
    const r = await runCli(['--version'], { root: tmpProject() });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`version: ${VERSION}\n`);
  });

  it('help prints the reference, exit 0', async () => {
    const r = await runCli(['help'], { root: tmpProject() });
    expect(r.code).toBe(0);
    expect(r.out).toContain('two80 - Deploy and share your app');
    expect(r.out).not.toContain('--json');
    expect(r.out).not.toContain('list, logs'); // roadmap stubs dropped from help
  });
});

class SecretNoticeFake extends Fake {
  async status(appId: string, deployId: string): Promise<DeployStatus> {
    return {
      ...(await super.status(appId, deployId)),
      secretNotice:
        'declared secrets are not configured: STRIPE_KEY, SUPABASE_SERVICE_ROLE_KEY. Configure them at https://console.280apps.com/dashboard/app_000001',
    };
  }
}

describe('push (fake)', () => {
  it('auto-inits and deploys to a live URL, writing config', async () => {
    const root = tmpProject();
    const r = await runCli(['push'], { root, port: new Fake() });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.url).toContain('280apps.run');
    expect(t.slug).not.toBe('');
    const body = fs.readFileSync(path.join(root, '.280', 'config.json'), 'utf8');
    expect(body).toContain('"framework": "static"');
    // Progress narration is on stderr, never stdout.
    expect(r.err).toContain('two80: uploaded');
    expect(r.out).not.toContain('uploaded');
  });

  it('relays the server-computed secret diff without changing stdout or blocking', async () => {
    const r = await runCli(['push'], { root: tmpProject(), port: new SecretNoticeFake() });
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      'two80: declared secrets are not configured: STRIPE_KEY, SUPABASE_SERVICE_ROLE_KEY. Configure them at https://console.280apps.com/dashboard/app_000001\n',
    );
    expect(r.out).not.toContain('STRIPE_KEY');
  });

  it('prints no secret message when the server reports no diff', async () => {
    const r = await runCli(['push'], { root: tmpProject(), port: new Fake() });
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('not configured');
  });

  it('rejects an unknown flag, exit 2', async () => {
    const r = await runCli(['push', '--stat'], { root: tmpProject(), port: new Fake() });
    expect(r.code).toBe(2);
    expect(parseToon(r.out).error).toBe('unknown_flag');
    expect(r.out).toContain('unknown flag --stat for `push`');
  });

  it('rejects the retired egress manifest before opening the port', async () => {
    const root = tmpProject({
      'index.html': '<h1>hi</h1>',
      '280.json': JSON.stringify({ egress: { allow: ['api.stripe.com'] } }),
    });
    const openPort = async (): Promise<never> => {
      throw new Error('openPort must not run when the manifest is invalid');
    };
    const r = await runCli(['push'], {
      root,
      deps: { buildBundle: async (dir) => build(dir, 'static'), openPort },
    });
    expect(r.code).toBe(1);
    expect(parseToon(r.out).message).toContain('egress');
  });

});

describe('whoami', () => {
  it('logged out is a definitive answer: loggedIn false, exit 0, login hint', async () => {
    const r = await runCli(['whoami'], { root: tmpProject(), auth: stubAuth({ api: API }) });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.loggedIn).toBe('false');
    expect(r.out).toContain('Run `two80 login`');
  });

  it('finishes an approved login and reports logged in, exit 0', async () => {
    credentials.save({
      token: '',
      api: API,
      pending: { deviceCode: 'dev-1', userCode: 'ABCD-EFGH', url: API + '/activate', expiresAt: 2_000_000, api: API },
    });
    const r = await runCli(['whoami'], { root: tmpProject(), auth: stubAuth({ api: API, token: 'tok-minted' }), now: 1_000_000 });
    expect(r.code).toBe(0);
    expect(parseToon(r.out).loggedIn).toBe('true');
    expect(credentials.load().creds.token).toBe('tok-minted');
  });

  it('an unconfirmed login is honestly logged out, exit 0', async () => {
    credentials.save({
      token: '',
      api: API,
      pending: { deviceCode: 'dev-1', userCode: 'ABCD-EFGH', url: API + '/activate', expiresAt: 2_000_000, api: API },
    });
    const r = await runCli(['whoami'], { root: tmpProject(), auth: stubAuth({ api: API }), now: 1_000_000 });
    expect(r.code).toBe(0);
    expect(parseToon(r.out).loggedIn).toBe('false');
  });
});

describe('login', () => {
  it('starts a device login and returns authorization_pending with the link, exit 1', async () => {
    const r = await runCli(['login'], { root: tmpProject(), auth: stubAuth({ api: API }), now: 1_000_000 });
    expect(r.code).toBe(1);
    const t = parseToon(r.out);
    expect(t.error).toBe('authorization_pending');
    expect(t.fix).toContain('/activate');
    expect(t.fix).toContain('ABCD-EFGH');
  });
});

describe('delete', () => {
  it('before any push: idempotent no-op, exit 0', async () => {
    const r = await runCli(['delete'], { root: tmpProject(), port: new Fake() });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.deleted).toBe('false');
    expect(t.note).toContain('no-op');
    expect(r.out).toContain('two80 push');
  });

  it('a binding the server no longer knows: no-op, exit 0, unbinds', async () => {
    const root = tmpProject();
    config.save(root, { name: 'demo', framework: 'static', appId: 'app_gone', clientRef: 'cr_x' });
    const r = await runCli(['delete', '--yes', 'demo'], { root, port: new Fake() });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.deleted).toBe('false');
    expect(t.note).toContain('already deleted');
    expect(config.load(root).cfg.appId).toBe('');
  });

  it('without confirmation: names the app, deletes nothing, exit 1', async () => {
    const root = tmpProject();
    const fake = new Fake();
    const pushed = await runCli(['push'], { root, port: fake });
    const slug = parseToon(pushed.out).slug;
    const appId = config.load(root).cfg.appId;

    const r = await runCli(['delete'], { root, port: fake });
    expect(r.code).toBe(1);
    const t = parseToon(r.out);
    expect(t.error).toBe('confirmation_required');
    expect(t.fix).toBe(`run two80 delete --yes ${slug}`);
    expect(config.load(root).cfg.appId).toBe(appId);
  });

  it('the wrong name is refused and leaves the binding intact, exit 1', async () => {
    const root = tmpProject();
    const fake = new Fake();
    const pushed = await runCli(['push'], { root, port: fake });
    const slug = parseToon(pushed.out).slug;
    const appId = config.load(root).cfg.appId;

    const r = await runCli(['delete', '--yes', slug + '-typo'], { root, port: fake });
    expect(r.code).toBe(1);
    expect(config.load(root).cfg.appId).toBe(appId);
  });

  it('with the right name: deletes and unbinds, exit 0; next push creates a new app', async () => {
    const root = tmpProject();
    const fake = new Fake();
    const pushed = await runCli(['push'], { root, port: fake });
    const slug = parseToon(pushed.out).slug;
    const firstId = config.load(root).cfg.appId;

    const del = await runCli(['delete', '--yes', slug], { root, port: fake });
    expect(del.code).toBe(0);
    const t = parseToon(del.out);
    expect(t.deleted).toBe('true');
    expect(t.slug).toBe(slug);
    const after = config.load(root).cfg;
    expect(after.appId).toBe('');
    expect(after.name).toBe(slug);
    expect(after.framework).toBe('static');

    const again = await runCli(['push'], { root, port: fake });
    expect(again.code).toBe(0);
    expect(config.load(root).cfg.appId).not.toBe(firstId);
    expect(config.load(root).cfg.appId).not.toBe('');
  });
});

describe('errors and stubs', () => {
  it('unknown command: exit 1 with a fix', async () => {
    const r = await runCli(['frobnicate'], { root: tmpProject() });
    expect(r.code).toBe(1);
    const t = parseToon(r.out);
    expect(t.error).toBe('unknown_command');
    expect(t.fix).toBe('run two80 help');
  });

  it('a dropped stub command still returns not_implemented, exit 1', async () => {
    const r = await runCli(['list'], { root: tmpProject() });
    expect(r.code).toBe(1);
    const t = parseToon(r.out);
    expect(t.error).toBe('not_implemented');
    expect(t.fix).toContain('two80 help');
  });

  it('the removed --json flag gets a targeted hint, exit 2, in any position', async () => {
    const global = await runCli(['--json'], { root: tmpProject() });
    expect(global.code).toBe(2);
    expect(parseToon(global.out).error).toBe('removed_flag');
    expect(global.out).toContain('TOON');

    const perCmd = await runCli(['push', '--json'], { root: tmpProject(), port: new Fake() });
    expect(perCmd.code).toBe(2);
    expect(parseToon(perCmd.out).error).toBe('removed_flag');
  });

  it('an unknown global flag is misuse, exit 2, listing global flags', async () => {
    const r = await runCli(['--frobnicate'], { root: tmpProject() });
    expect(r.code).toBe(2);
    const t = parseToon(r.out);
    expect(t.error).toBe('unknown_flag');
    expect(r.out).toContain('--version');
  });
});

describe('init', () => {
  it('writes config and suggests push, exit 0', async () => {
    const root = tmpProject();
    const r = await runCli(['init'], { root });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.framework).toBe('static');
    expect(t.created).toBe('true');
    expect(r.out).toContain('help[1]: Run `two80 push` to deploy');
  });

  it('re-init is a no-op reporting created=false, exit 0', async () => {
    const root = tmpProject();
    await runCli(['init'], { root });
    const r = await runCli(['init'], { root });
    expect(r.code).toBe(0);
    expect(parseToon(r.out).created).toBe('false');
  });
});

describe('bare two80 home view', () => {
  it('shows bin, description, app state, login state, and next steps', async () => {
    const root = tmpProject();
    const r = await runCli([], { root, binPath: '/usr/local/bin/two80' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('bin: /usr/local/bin/two80');
    expect(r.out).toContain('description: Deploy and share your app');
    expect(r.out).toContain('app: none in this directory');
    expect(r.out).toContain('login: not logged in');
    expect(r.out).toContain('help[1]: Run `two80 push`');
  });
});

describe('status', () => {
  it('before any push: no_app error with a fix', async () => {
    const r = await runCli(['status'], { root: tmpProject(), port: new Fake() });
    expect(r.code).toBe(1);
    const t = parseToon(r.out);
    expect(t.error).toBe('no_app');
    expect(t.fix).toContain('two80 status <app>');
  });

  it('explicit app ID wins over directory config', async () => {
    const fake = new Fake();
    const root = tmpProject();
    const pushed = await runCli(['push'], { root, port: fake });
    const appId = parseToon(pushed.out).appId;

    const r = await runCli(['status', appId], { root: tmpProject(), port: fake });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.state).toBe('live');
    expect(t.url).toContain('280apps.run');
  });

  it('reports live state with URL after a successful push', async () => {
    const fake = new Fake();
    const root = tmpProject();
    await runCli(['push'], { root, port: fake });

    const r = await runCli(['status'], { root, port: fake });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.state).toBe('live');
    expect(t.url).toContain('280apps.run');
  });

  it('reports not_found for an explicit app that does not exist', async () => {
    const r = await runCli(['status', 'app_missing'], { root: tmpProject(), port: new Fake() });
    expect(r.code).toBe(1);
    const t = parseToon(r.out);
    expect(t.error).toBe('not_found');
  });

  it('status --help prints usage and exits 0', async () => {
    const r = await runCli(['status', '--help'], { root: tmpProject() });
    expect(r.code).toBe(0);
    expect(r.out).toContain('two80 status - check your app');
  });
});

// End-to-end "fake push": the whole command surface (app.run) over the real
// static bundler and real Fake port, the closest a unit test gets to `two80 push`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeployStatus } from '@280/contracts';
import { Fake } from '@280/contracts/deploy/fake';
import { build } from '../src/bundle/index.js';
import * as config from '../src/config.js';
import { parseToon, runCli, tmpHome, tmpProject } from './helpers.js';

const prev = process.env.TWO80_HOME;
beforeEach(() => {
  process.env.TWO80_HOME = tmpHome();
  delete process.env.TWO80_API;
});
afterEach(() => {
  if (prev === undefined) delete process.env.TWO80_HOME;
  else process.env.TWO80_HOME = prev;
});

const realBundle = { buildBundle: async (root: string, framework: string) => build(root, framework) };

function staticSite(): string {
  return tmpProject({ 'package.json': JSON.stringify({ name: 'demo' }), 'index.html': '<h1>hi</h1>' });
}

class IntegrationWaitFake extends Fake {
  connected = false;

  async status(appId: string, deployId: string): Promise<DeployStatus> {
    const status = await super.status(appId, deployId);
    if (this.connected) return status;
    // A required integration with no bound resource parks the deploy (never live)
    // until the alias is bound in the dashboard, exactly like a missing secret.
    return {
      state: 'waiting_secrets',
      url: '',
      notice: '',
      secretNotice: '',
      integrationNotice:
        `integration not connected: todos (google-sheets). Connect it at ` +
        `https://console.280apps.com/dashboard/${appId}?integrations=1`,
      failure: undefined,
    };
  }
}

class CredentialWaitFake extends Fake {
  configured = false;
  statusCalls = 0;

  async status(appId: string, deployId: string): Promise<DeployStatus> {
    this.statusCalls++;
    const status = await super.status(appId, deployId);
    if (this.configured) return status;
    return {
      state: 'waiting_secrets',
      url: '',
      notice: '',
      secretNotice:
        `declared secrets are not configured: STRIPE_KEY, GOOGLE_SERVICE_ACCOUNT. ` +
        `Configure them at https://console.280apps.com/dashboard/${appId}?variables=1`,
      failure: undefined,
    };
  }
}

describe('fake push (real bundler + real Fake, through app.run)', () => {
  it('auto-inits, bundles, deploys to a live URL, exit 0', async () => {
    const root = staticSite();
    const fake = new Fake();
    const r = await runCli(['push'], { root, port: fake, deps: realBundle });
    expect(r.code).toBe(0);
    const t = parseToon(r.out);
    expect(t.url).toContain('280apps.run');
    expect(t.slug).toBe('demo');
    expect(fake.appCount()).toBe(1);
    expect(config.load(root).cfg.appId).toBe(t.appId);
  });

  it('re-push is idempotent: no duplicate app', async () => {
    const root = staticSite();
    const fake = new Fake();
    const first = await runCli(['push'], { root, port: fake, deps: realBundle });
    const second = await runCli(['push'], { root, port: fake, deps: realBundle });
    expect(second.code).toBe(0);
    expect(fake.appCount()).toBe(1);
    expect(parseToon(second.out).appId).toBe(parseToon(first.out).appId);
  });

  it('returns a credential action promptly and resumes the same push after configuration', async () => {
    const root = staticSite();
    const fake = new CredentialWaitFake();

    const waiting = await runCli(['push'], { root, port: fake, deps: realBundle });

    expect(waiting.code).toBe(1);
    expect(parseToon(waiting.out).error).toBe('credentials_required');
    expect(waiting.out).toContain('STRIPE_KEY, GOOGLE_SERVICE_ACCOUNT');
    expect(waiting.out).toContain('https://console.280apps.com/dashboard/app_000001?variables=1');
    expect(waiting.out).toContain('ask your user to configure the missing credentials');
    expect(waiting.out).toContain('then run `two80 push` again');
    expect(waiting.err).not.toContain('Push continues automatically');
    expect(fake.statusCalls).toBe(1);
    expect(fake.appCount()).toBe(1);
    const appId = config.load(root).cfg.appId;

    fake.configured = true;
    const resumed = await runCli(['push'], { root, port: fake, deps: realBundle });

    expect(resumed.code).toBe(0);
    expect(parseToon(resumed.out).appId).toBe(appId);
    expect(parseToon(resumed.out).url).toContain('280apps.run');
    expect(fake.appCount()).toBe(1);
  });

  it('returns an integration action and hands over the live URL after connection', async () => {
    const root = tmpProject({
      'package.json': JSON.stringify({ name: 'demo' }),
      'index.html': '<h1>hi</h1>',
      '280.json': JSON.stringify({
        integrations: { todos: { capability: 'google-sheets', operations: ['read', 'append'] } },
      }),
    });
    const fake = new IntegrationWaitFake();

    const waiting = await runCli(['push'], { root, port: fake, deps: realBundle });

    expect(waiting.code).toBe(1);
    expect(parseToon(waiting.out).error).toBe('credentials_required');
    expect(waiting.out).toContain('todos (google-sheets)');
    expect(waiting.out).toContain('https://console.280apps.com/dashboard/app_000001?integrations=1');
    expect(waiting.out).toContain('ask your user to connect the integration');
    const appId = config.load(root).cfg.appId;

    fake.connected = true;
    const resumed = await runCli(['push'], { root, port: fake, deps: realBundle });

    expect(resumed.code).toBe(0);
    expect(parseToon(resumed.out).appId).toBe(appId);
    expect(parseToon(resumed.out).url).toContain('280apps.run');
    expect(fake.appCount()).toBe(1);
  });

  it('push then delete by slug removes the app, exit 0', async () => {
    const root = staticSite();
    const fake = new Fake();
    await runCli(['push'], { root, port: fake, deps: realBundle });
    const del = await runCli(['delete', '--yes', 'demo'], { root, port: fake, deps: realBundle });
    expect(del.code).toBe(0);
    expect(parseToon(del.out).deleted).toBe('true');
    expect(config.load(root).cfg.appId).toBe('');
  });

  it('an unsupported project fails preflight before any deploy, exit 1', async () => {
    const root = tmpProject({ 'readme.txt': 'nothing deployable' });
    const fake = new Fake();
    const r = await runCli(['push'], { root, port: fake, deps: realBundle });
    expect(r.code).toBe(1);
    expect(parseToon(r.out).error).toBe('preflight_rejected');
    expect(fake.appCount()).toBe(0);
  });
});

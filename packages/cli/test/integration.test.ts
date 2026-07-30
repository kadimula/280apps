// End-to-end "fake push": the whole command surface (app.run) over the real
// static bundler and real Fake port, the closest a unit test gets to `280 push`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fake } from '@280/contracts/deploy/fake';
import { build } from '../src/bundle/index.js';
import * as config from '../src/config.js';
import { VERSION } from '../src/app.js';
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

describe('version drift guard', () => {
  it('app VERSION matches package.json (fixtures normalize the version, so keep them aligned)', () => {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

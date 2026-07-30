// The deploy loop against the real Fake, mirroring cli/internal/push/push_test.go.

import { describe, expect, it } from 'vitest';
import type { Port } from '@280/contracts';
import { Fake } from '@280/contracts/deploy/fake';
import * as config from '../src/config.js';
import * as push from '../src/push.js';
import { testBundle, tmpProject } from './helpers.js';

function project(): { root: string; cfg: config.Config } {
  const root = tmpProject({ 'index.html': '<h1>hello</h1>' });
  const cfg: config.Config = { name: 'demo', framework: 'static', appId: '', clientRef: 'cr_test' };
  config.save(root, cfg);
  return { root, cfg };
}

describe('push.run against the Fake', () => {
  it('happy path: reaches a live URL, resolves created, persists appId', async () => {
    const { root, cfg } = project();
    const fake = new Fake();
    const res = await push.run(fake, cfg, testBundle(), { root });
    expect(res.url).not.toBe('');
    expect(res.resolution).toBe('created');
    const saved = config.load(root).cfg;
    expect(saved.appId).not.toBe('');
    expect(saved.appId).toBe(res.app.id);
  });

  it('self-heals from transient retryable faults', async () => {
    const { root, cfg } = project();
    const fake = new Fake();
    fake.failNext(3); // Sync/PutBlob/Status fail retryably before succeeding
    const res = await push.run(fake, cfg, testBundle(), { root });
    expect(res.url).not.toBe('');
  });

  it('is idempotent across runs: no duplicate app, stable identity', async () => {
    const { root, cfg } = project();
    const fake = new Fake();
    const first = await push.run(fake, cfg, testBundle(), { root });
    const reloaded = config.load(root).cfg;
    const second = await push.run(fake, reloaded, testBundle(), { root });
    expect(fake.appCount()).toBe(1);
    expect(second.app.id).toBe(first.app.id);
    expect(second.resolution).not.toBe('created');
  });

  it('--new forces a second app', async () => {
    const { root, cfg } = project();
    const fake = new Fake();
    await push.run(fake, cfg, testBundle(), { root, gitRemote: 'git@github.com:x/y.git' });
    const cfg2: config.Config = { name: 'demo', framework: 'static', appId: '', clientRef: 'cr_test2' };
    await push.run(fake, cfg2, testBundle(), { root, gitRemote: 'git@github.com:x/y.git', forceNew: true });
    expect(fake.appCount()).toBe(2);
  });

  it('surfaces a non-retryable failure on the first call, without retrying', async () => {
    const { root, cfg } = project();
    let syncs = 0;
    const port: Port = {
      async sync() {
        syncs++;
        throw { code: 'preflight_rejected', message: 'worker too big', fix: 'shrink it', retryable: false };
      },
      async putBlob() {},
      async status() {
        return { state: 'live', url: '', failure: undefined };
      },
      async delete() {
        return { app: { id: '', slug: '', url: '' }, deleted: false };
      },
    };
    await expect(push.run(port, cfg, testBundle(), { root })).rejects.toMatchObject({ code: 'preflight_rejected' });
    expect(syncs).toBe(1); // non-retryable => no retry loop
  });

  it('retries a retryable Sync error before giving up', async () => {
    const { root, cfg } = project();
    const fake = new Fake();
    fake.failNext(1); // first Sync fails retryably
    let syncs = 0;
    const counting: Port = {
      async sync(req) {
        syncs++;
        return fake.sync(req);
      },
      putBlob: (a, d, s, b) => fake.putBlob(a, d, s, b),
      status: (a, d) => fake.status(a, d),
      delete: (r) => fake.delete(r),
    };
    const res = await push.run(counting, cfg, testBundle(), { root });
    expect(res.url).not.toBe('');
    expect(syncs).toBeGreaterThanOrEqual(2); // one failure then a real Sync
  });

  it('narrates progress through Events', async () => {
    const { root, cfg } = project();
    const fake = new Fake();
    const uploads: string[] = [];
    let resolved = '';
    await push.run(fake, cfg, testBundle(), { root }, {
      onResolve: (app, r) => (resolved = `${r}:${app.slug}`),
      onUpload: (done, total) => uploads.push(`${done}/${total}`),
    });
    expect(resolved).toBe('created:demo');
    expect(uploads).toEqual(['1/2', '2/2']);
  });
});

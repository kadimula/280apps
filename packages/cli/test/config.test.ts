import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../src/config.js';
import { tmpProject } from './helpers.js';

describe('config', () => {
  it('load returns found=false for an uninitialized project', () => {
    const root = tmpProject({ 'index.html': 'x' });
    const { found, cfg } = config.load(root);
    expect(found).toBe(false);
    expect(cfg).toEqual({ name: '', framework: '', appId: '', clientRef: '' });
  });

  it('save then load round-trips every field', () => {
    const root = tmpProject({ 'index.html': 'x' });
    const cfg: config.Config = { name: 'demo', framework: 'static', appId: 'app_000001', clientRef: 'cr_abc' };
    config.save(root, cfg);
    const { found, cfg: got } = config.load(root);
    expect(found).toBe(true);
    expect(got).toEqual(cfg);
  });

  it('writes .280/config.json with two-space indent, Go field order, trailing newline', () => {
    const root = tmpProject({ 'index.html': 'x' });
    config.save(root, { name: 'demo', framework: 'static', appId: '', clientRef: 'cr_x' });
    const body = fs.readFileSync(path.join(root, '.280', 'config.json'), 'utf8');
    expect(body).toBe(
      '{\n  "name": "demo",\n  "framework": "static",\n  "appId": "",\n  "clientRef": "cr_x"\n}\n',
    );
  });

  it('save is atomic: no stray temp files remain in .280/', () => {
    const root = tmpProject({ 'index.html': 'x' });
    config.save(root, { name: 'demo', framework: 'static', appId: '', clientRef: 'cr_x' });
    const entries = fs.readdirSync(path.join(root, '.280'));
    expect(entries).toEqual(['config.json']);
  });

  it('load tolerates a partial config (absent fields become zero values)', () => {
    const root = tmpProject({ 'index.html': 'x' });
    fs.mkdirSync(path.join(root, '.280'));
    fs.writeFileSync(path.join(root, '.280', 'config.json'), '{"name":"demo"}');
    const { found, cfg } = config.load(root);
    expect(found).toBe(true);
    expect(cfg).toEqual({ name: 'demo', framework: '', appId: '', clientRef: '' });
  });
});

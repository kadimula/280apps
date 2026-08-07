import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as config from '../src/config.js';
import * as credentials from '../src/credentials.js';
import { render } from '../src/homeview.js';
import { tmpHome, tmpProject } from './helpers.js';

const API = 'https://api.280apps.com';
const prev = process.env.TWO80_HOME;

beforeEach(() => {
  process.env.TWO80_HOME = tmpHome();
});
afterEach(() => {
  if (prev === undefined) delete process.env.TWO80_HOME;
  else process.env.TWO80_HOME = prev;
});

const params = (root: string) => ({ binPath: '/usr/local/bin/two80', root, api: API });

describe('homeview.render', () => {
  it('no config: none in this directory, logged out, suggests push', () => {
    const out = render(params(tmpProject({ 'index.html': 'x' })));
    expect(out).toContain('bin: /usr/local/bin/two80');
    expect(out).toContain('description: Deploy and share your app');
    expect(out).toContain('app: none in this directory');
    expect(out).toContain('login: not logged in');
    expect(out).toContain('help[1]: Run `two80 push` to create and deploy this app');
  });

  it('config without appId: not yet deployed', () => {
    const root = tmpProject({ 'index.html': 'x' });
    config.save(root, { name: 'demo', framework: 'static', appId: '', clientRef: 'cr_x' });
    const out = render(params(root));
    expect(out).toContain('app: demo (static) not yet deployed');
    expect(out).toContain('help[1]: Run `two80 push` to deploy');
  });

  it('deployed app: shows deployed and offers redeploy + delete', () => {
    const root = tmpProject({ 'index.html': 'x' });
    config.save(root, { name: 'demo', framework: 'static', appId: 'app_000001', clientRef: 'cr_x' });
    const out = render(params(root));
    expect(out).toContain('app: demo (static) deployed');
    expect(out).toContain('Run `two80 push` to redeploy');
    expect(out).toContain('Run `two80 delete --yes demo` to remove it');
  });

  it('logged in when a token for this api is present', () => {
    const root = tmpProject({ 'index.html': 'x' });
    credentials.save({ token: 'tok', api: API });
    expect(render(params(root))).toContain('login: logged in');
  });

  it('stays within the ~10 line budget', () => {
    const root = tmpProject({ 'index.html': 'x' });
    config.save(root, { name: 'demo', framework: 'static', appId: 'app_000001', clientRef: 'cr_x' });
    expect(render(params(root)).split('\n').length).toBeLessThanOrEqual(10);
  });

  it('collapses the home directory to ~ in the bin path', () => {
    const root = tmpProject({ 'index.html': 'x' });
    const home = process.env.HOME ?? '';
    if (home) {
      const out = render({ binPath: `${home}/.local/bin/two80`, root, api: API });
      expect(out).toContain('bin: ~/.local/bin/two80');
    }
  });
});

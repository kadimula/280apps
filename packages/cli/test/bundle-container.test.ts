import { describe, expect, it } from 'vitest';
import { buildNextContainer } from '../src/bundle/container.js';
import type { Bundle } from '../src/bundle/static.js';
import { tmpProject } from './helpers.js';

function fileText(bundle: Bundle, path: string): string | undefined {
  const f = bundle.manifest.files.find((x) => x.path === path);
  if (f === undefined) return undefined;
  const bytes = bundle.content.get(f.digest);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

describe('Next.js buildpack instrumentation injection', () => {
  it('injects instrumentation.js with the onRequestError hook when the app has none', () => {
    const root = tmpProject({ 'package.json': JSON.stringify({ name: 'demo' }), 'app/page.tsx': 'export default () => null;' });
    const bundle = buildNextContainer(root);
    const text = fileText(bundle, 'instrumentation.js');
    expect(text).toBeDefined();
    expect(text).toContain('export function onRequestError');
    expect(text).toContain("t: '280.error'");
    expect(bundle.notes.some((n) => n.includes('two80 logs --digest'))).toBe(true);
  });

  it('does not clobber an existing instrumentation.ts', () => {
    const own = 'export function register() {}\n';
    const root = tmpProject({ 'package.json': JSON.stringify({ name: 'demo' }), 'instrumentation.ts': own });
    const bundle = buildNextContainer(root);
    expect(fileText(bundle, 'instrumentation.js')).toBeUndefined();
    expect(fileText(bundle, 'instrumentation.ts')).toBe(own);
    expect(bundle.notes.some((n) => n.includes('two80 logs'))).toBe(false);
  });

  it('places the hook under src/ when the app uses a src directory', () => {
    const root = tmpProject({ 'package.json': JSON.stringify({ name: 'demo' }), 'src/app/page.tsx': 'export default () => null;' });
    const bundle = buildNextContainer(root);
    expect(fileText(bundle, 'src/instrumentation.js')).toContain('onRequestError');
    expect(fileText(bundle, 'instrumentation.js')).toBeUndefined();
  });

  it('skips injection when the app brings its own Dockerfile (280 does not own the build)', () => {
    const root = tmpProject({
      'package.json': JSON.stringify({ name: 'demo' }),
      Dockerfile: 'FROM node:20\nCMD ["npm","start"]\n',
      'app/page.tsx': 'export default () => null;',
    });
    const bundle = buildNextContainer(root);
    expect(fileText(bundle, 'instrumentation.js')).toBeUndefined();
  });
});

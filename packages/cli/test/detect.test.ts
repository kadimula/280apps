import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as detect from '../src/detect.js';
import { tmpProject } from './helpers.js';

describe('slugify (mirrors cli/internal/detect Slugify, not the server ≤40 sanitize)', () => {
  const cases: [string, string][] = [
    ['My App', 'my-app'],
    ['  spaced  name  ', 'spaced-name'],
    ['UPPER_case-123', 'upper-case-123'],
    ['!!!', 'app'],
    ['', 'app'],
    ['café-münchen', 'caf-m-nchen'],
    ['@scope/pkg', 'scope-pkg'],
    ['---leading-and-trailing---', 'leading-and-trailing'],
    ['already-good', 'already-good'],
  ];
  for (const [raw, want] of cases) {
    it(`${JSON.stringify(raw)} -> ${want}`, () => {
      expect(detect.slugify(raw)).toBe(want);
    });
  }

  it('does not truncate at 40 chars (that cap is the server sanitize, not the CLI)', () => {
    const long = 'a.very.long.name.that.definitely.exceeds.the.forty.character.limit.for.slugs';
    expect(detect.slugify(long)).toBe('a-very-long-name-that-definitely-exceeds-the-forty-character-limit-for-slugs');
  });
});

describe('framework detection', () => {
  it('detects next when package.json depends on next', () => {
    const root = tmpProject({ 'package.json': JSON.stringify({ name: 'x', dependencies: { next: '14' } }) });
    expect(detect.framework(root)).toBe('next');
  });

  it('detects next from devDependencies', () => {
    const root = tmpProject({ 'package.json': JSON.stringify({ name: 'x', devDependencies: { next: '14' } }) });
    expect(detect.framework(root)).toBe('next');
  });

  it('detects static from index.html', () => {
    const root = tmpProject({ 'index.html': '<h1>hi</h1>' });
    expect(detect.framework(root)).toBe('static');
  });

  it('detects static from a build dir index.html', () => {
    const root = tmpProject({ 'dist/index.html': '<h1>hi</h1>' });
    expect(detect.framework(root)).toBe('static');
  });

  it('throws preflight_rejected when nothing is recognized', () => {
    const root = tmpProject({ 'readme.txt': 'hello' });
    expect(() => detect.framework(root)).toThrow(
      expect.objectContaining({ code: 'preflight_rejected', fix: expect.stringContaining('--framework') }),
    );
  });
});

describe('slug source', () => {
  it('prefers package.json name', () => {
    const root = tmpProject({ 'package.json': JSON.stringify({ name: 'My App' }), 'index.html': 'x' });
    expect(detect.slug(root)).toBe('my-app');
  });

  it('falls back to the directory name', () => {
    const root = tmpProject({ 'index.html': 'x' });
    // mkdtemp dir base begins with 280-test-; slugified stays lowercase alnum+hyphens
    expect(detect.slug(root)).toMatch(/^[a-z0-9-]+$/);
    expect(detect.slug(root)).toBe(pathBaseSlug(root));
  });
});

function pathBaseSlug(root: string): string {
  // Mirror detect.slug's fallback for the assertion.
  const base = path.basename(path.resolve(root));
  return detect.slugify(base);
}

it('a bare directory named index.html is not a static entry', () => {
  const root = tmpProject({ 'other.txt': 'x' });
  fs.mkdirSync(path.join(root, 'index.html'));
  expect(() => detect.framework(root)).toThrow();
});

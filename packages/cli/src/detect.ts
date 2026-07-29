// detect infers a project's framework and default app slug from the files on
// disk. init/push depend on it so the agent never has to declare the framework
// by hand. Detection is intentionally narrow: V1 supports Next.js and plain
// static builds, and an unrecognized project fails loudly rather than guessing.
// Spec: cli/internal/detect/detect.go. Go is normative, including the slug rules.

import fs from 'node:fs';
import path from 'node:path';
import { DeployCode } from '@280/contracts';
import { fail } from './output.js';

// Frameworks the CLI can deploy.
export const FrameworkNext = 'next';
export const FrameworkStatic = 'static';

export interface DetectResult {
  framework: string; // "next" | "static"
  slug: string; // default app name, from package.json name or the dir
}

// framework detects root's framework: Next.js when package.json depends on
// `next`; else static when an index.html or a common build dir exists; else a
// structured preflight_rejected error naming what is supported.
export function framework(root: string): string {
  if (hasNextDependency(root)) return FrameworkNext;
  if (hasStaticEntry(root)) return FrameworkStatic;
  throw fail(
    DeployCode.PreflightRejected,
    'no supported framework found: need a Next.js project (next in package.json) or a static build (index.html)',
    'cd into your app directory, or pass 280 init --framework next|static',
  );
}

// detect resolves both framework and default slug.
export function detect(root: string): DetectResult {
  return { framework: framework(root), slug: slug(root) };
}

// slug is the default app name: package.json "name" slugified, else the project
// directory name slugified.
export function slug(root: string): string {
  const pkg = readPackageJSON(root);
  if (pkg && pkg.name) return slugify(pkg.name);
  return slugify(path.basename(path.resolve(root)));
}

interface PackageJSON {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJSON(root: string): PackageJSON | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as PackageJSON;
  } catch {
    return null;
  }
}

function hasNextDependency(root: string): boolean {
  const pkg = readPackageJSON(root);
  if (!pkg) return false;
  return !!(pkg.dependencies && 'next' in pkg.dependencies) || !!(pkg.devDependencies && 'next' in pkg.devDependencies);
}

function hasStaticEntry(root: string): boolean {
  if (fileExists(path.join(root, 'index.html'))) return true;
  for (const dir of ['dist', 'build', 'public', 'out']) {
    if (fileExists(path.join(root, dir, 'index.html'))) return true;
  }
  return false;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const NON_SLUG = /[^a-z0-9]+/g;

// slugify lowercases, strips an npm scope leader, replaces runs of
// non-alphanumerics with a hyphen, and trims hyphens. An empty or all-symbol
// input becomes "app". Matches detect.go Slugify byte for byte.
export function slugify(s: string): string {
  s = s.trim().toLowerCase();
  if (s.startsWith('@')) s = s.slice(1); // npm scope leader
  s = s.replace(NON_SLUG, '-');
  s = trim(s, '-');
  return s === '' ? 'app' : s;
}

function trim(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

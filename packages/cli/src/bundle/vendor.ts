import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { digestBytes, type BlobInfo, type Digest } from '@280/contracts';
import { dirExists, fail, walkContext } from './walk.js';

const VENDOR_ROOT = '.two80-vendor';
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const RUNTIME_DEP_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const DROP_MANIFEST_FIELDS = ['devDependencies', 'scripts', 'publishConfig'] as const;
const UNRESOLVABLE_SPEC = /^(workspace|file|link):/;
const VENDOR_SKIP = new Set(['node_modules', '.git', '.turbo', '.cache']);

type Json = Record<string, unknown>;

interface Vendored {
  name: string;
  oldSpec: string;
  oldRel: string;
  newPrefix: string;
}

function fileSpecPath(spec: string): string | null {
  if (!spec.startsWith('file:')) return null;
  return spec.slice(5);
}

function escapesRoot(root: string, rel: string): boolean {
  const rp = relative(root, resolve(root, rel));
  return rp === '' || rp.startsWith('..') || isAbsolute(rp);
}

function sanitizeKey(name: string, taken: Set<string>): string {
  const base = name.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dep';
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  taken.add(key);
  return key;
}

function collect(root: string, pkg: Json): Vendored[] {
  const taken = new Set<string>();
  const byRel = new Map<string, Vendored>();
  const out: Vendored[] = [];
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Json)) {
      if (typeof spec !== 'string') continue;
      const rel = fileSpecPath(spec);
      if (rel === null || !escapesRoot(root, rel)) continue;
      const normRel = rel.replace(/^\.\//, '').replace(/\/+$/, '');
      const seen = byRel.get(normRel);
      if (seen) {
        out.push({ ...seen, name, oldSpec: spec });
        continue;
      }
      const v: Vendored = {
        name,
        oldSpec: spec,
        oldRel: normRel,
        newPrefix: `${VENDOR_ROOT}/${sanitizeKey(name, taken)}`,
      };
      byRel.set(normRel, v);
      out.push(v);
    }
  }
  return out;
}

function rewriteSpecs(pkg: Json, vendored: Vendored[]): Json {
  const byName = new Map(vendored.map((v) => [v.name, `file:./${v.newPrefix}`]));
  const next: Json = { ...pkg };
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    const copy: Json = { ...(deps as Json) };
    for (const name of Object.keys(copy)) {
      const spec = byName.get(name);
      if (spec) copy[name] = spec;
    }
    next[section] = copy;
  }
  return next;
}

function remapPath(path: string, vendored: Vendored[]): string | null {
  for (const v of vendored) {
    if (path === v.oldRel) return v.newPrefix;
    if (path.startsWith(v.oldRel + '/')) return v.newPrefix + path.slice(v.oldRel.length);
  }
  return null;
}

function rewriteLock(lockText: string, vendored: Vendored[]): string {
  const lock = JSON.parse(lockText) as Json;
  const packages = lock.packages;
  if (packages && typeof packages === 'object') {
    const specByName = new Map(vendored.map((v) => [v.name, `file:./${v.newPrefix}`]));
    const next: Json = {};
    for (const [key, node] of Object.entries(packages as Json)) {
      const remappedKey = key === '' ? '' : remapPath(key, vendored) ?? key;
      if (node && typeof node === 'object') {
        const n = node as Json;
        if (vendored.some((v) => remappedKey === v.newPrefix)) {
          for (const field of DROP_MANIFEST_FIELDS) delete n[field];
        }
        if (typeof n.resolved === 'string') {
          const r = remapPath(n.resolved, vendored);
          if (r) n.resolved = r;
        }
        for (const section of DEP_SECTIONS) {
          const deps = n[section];
          if (!deps || typeof deps !== 'object') continue;
          for (const [name, spec] of Object.entries(deps as Json)) {
            const s = specByName.get(name);
            if (s && typeof spec === 'string' && spec.startsWith('file:')) (deps as Json)[name] = s;
          }
        }
      }
      next[remappedKey] = node;
    }
    lock.packages = next;
  }
  return JSON.stringify(lock, null, 2) + '\n';
}

function cleanVendorManifest(v: Vendored, targetAbs: string): string {
  const manifest = JSON.parse(readFileSync(join(targetAbs, 'package.json'), 'utf8')) as Json;
  for (const field of DROP_MANIFEST_FIELDS) delete manifest[field];
  for (const section of RUNTIME_DEP_SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Json)) {
      if (typeof spec === 'string' && UNRESOLVABLE_SPEC.test(spec)) {
        fail(
          `vendored dependency "${v.name}" needs "${name}": "${spec}", another local package the container cannot resolve`,
          'publish that dependency to a registry, or inline it, then run two80 push again',
        );
      }
    }
  }
  return JSON.stringify(manifest, null, 2) + '\n';
}

function replaceBlob(
  files: BlobInfo[],
  content: Map<Digest, Uint8Array>,
  path: string,
  text: string,
): void {
  const data = new TextEncoder().encode(text);
  const dig = digestBytes(data);
  content.set(dig, data);
  const existing = files.find((f) => f.path === path);
  if (existing) {
    existing.digest = dig;
    existing.size = data.length;
  } else {
    files.push({ path, digest: dig, size: data.length });
  }
}

export function vendorLocalFileDeps(
  root: string,
  files: BlobInfo[],
  content: Map<Digest, Uint8Array>,
): string[] {
  const pkgText = readFileSync(join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgText) as Json;
  const vendored = collect(root, pkg);
  if (vendored.length === 0) return [];

  const unique = new Map(vendored.map((v) => [v.newPrefix, v]));
  for (const v of unique.values()) {
    const targetAbs = resolve(root, v.oldRel);
    if (!dirExists(targetAbs)) {
      fail(
        `local dependency "${v.name}" points outside the app at ${v.oldSpec}, but that path does not exist`,
        'fix the dependency path in package.json, then run two80 push again',
      );
    }
    files.push(
      ...walkContext(targetAbs, content, {
        prefix: v.newPrefix,
        skip: (rel, isDir) => isDir && VENDOR_SKIP.has(rel.split('/').pop() ?? ''),
      }),
    );
    replaceBlob(files, content, `${v.newPrefix}/package.json`, cleanVendorManifest(v, targetAbs));
  }

  replaceBlob(files, content, 'package.json', JSON.stringify(rewriteSpecs(pkg, vendored), null, 2) + '\n');
  const lock = files.find((f) => f.path === 'package-lock.json');
  if (lock) {
    const lockText = new TextDecoder().decode(content.get(lock.digest));
    replaceBlob(files, content, 'package-lock.json', rewriteLock(lockText, vendored));
  }

  const names = [...unique.values()].map((v) => `${v.name} → ${v.newPrefix}`);
  return [`vendored local dependencies into the build context: ${names.join(', ')}`];
}

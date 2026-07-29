// The embedded StaticWorker must equal the verbatim static.js on disk, byte for
// byte. static.js is the source of truth (copied verbatim from the Go tree);
// embed.ts compiles it in as a base64 constant so the module is self-contained.
// This test is the guard that the two never drift.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StaticWorker } from '../../src/runtime/cloudflare/embed.js';

describe('StaticWorker', () => {
  it('is byte-identical to static.js', () => {
    const file = readFileSync(
      fileURLToPath(new URL('../../src/runtime/cloudflare/static.js', import.meta.url)),
    );
    expect(Buffer.from(StaticWorker).equals(file)).toBe(true);
  });

  it('is the static-app serving worker', () => {
    const text = new TextDecoder().decode(StaticWorker);
    expect(text).toContain('env.ASSETS.fetch(request)');
  });
});

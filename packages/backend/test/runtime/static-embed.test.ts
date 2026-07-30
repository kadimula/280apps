// The embedded StaticWorker must stay byte-identical to static.js on disk, the
// source of truth; embed.ts compiles it in as a base64 constant. This test guards
// against the two drifting.

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

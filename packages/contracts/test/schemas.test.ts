// Proves the wire schemas mirror Go encoding/json: unknown fields preserved,
// absent/null optionals become the Go zero value, no schema rejects extra fields.

import { describe, it, expect } from 'vitest';
import {
  identitySchema,
  manifestSchema,
  syncResultSchema,
  blobInfoSchema,
} from '../src/types.js';
import { errorSchema } from '../src/errors.js';

describe('loose parsing (Go encoding/json semantics)', () => {
  it('defaults absent optionals to Go zero values', () => {
    const id = identitySchema.parse({ slug: 'x', framework: 'static' });
    expect(id).toMatchObject({
      appId: '',
      slug: 'x',
      framework: 'static',
      gitRemote: '',
      clientRef: '',
      forceNew: false,
    });
  });

  it('preserves unknown fields (passthrough), never rejects them', () => {
    const id = identitySchema.parse({ slug: 'x', framework: 'next', futureField: 42 }) as Record<
      string,
      unknown
    >;
    expect(id['futureField']).toBe(42);
  });

  it('coerces null and absent files to an empty array', () => {
    const m = manifestSchema.parse({
      kind: 'container',
      build: { builder: 'next', dockerfile: 'Dockerfile', port: 8080 },
      files: null,
    });
    expect(m.files).toEqual([]);
    expect(m.build).toEqual({ builder: 'next', dockerfile: 'Dockerfile', port: 8080 });
  });

  it('fills a missing build with a zero BuildSpec and empty files', () => {
    const m = manifestSchema.parse({ kind: 'container' });
    expect(m.build).toEqual({ builder: '', dockerfile: '', port: 0 });
    expect(m.files).toEqual([]);
  });

  it('defaults blob size/path/digest to zero values', () => {
    expect(blobInfoSchema.parse({})).toEqual({ path: '', digest: '', size: 0 });
  });

  it('error schema defaults omitempty fields', () => {
    const e = errorSchema.parse({ code: 'unavailable', message: 'busy' });
    expect(e).toMatchObject({
      code: 'unavailable',
      message: 'busy',
      fix: '',
      retryable: false,
      candidates: [],
    });
  });

  it('sync result missing defaults to empty and absent failure is undefined', () => {
    const r = syncResultSchema.parse({
      app: { id: 'app_1', slug: 's', url: 'u' },
      resolution: 'created',
      deployId: 'dep_x',
      state: 'uploading',
    });
    expect(r.missing).toEqual([]);
    expect(r.failure).toBeUndefined();
  });
});

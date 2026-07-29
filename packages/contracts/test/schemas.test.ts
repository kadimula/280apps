// Proves the wire schemas mirror Go encoding/json (plan §1): unknown fields are
// preserved, absent/null optionals become the Go zero value, and no schema
// rejects extra fields. A strict schema here would break old Go clients.

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

  it('coerces null and absent lists to empty arrays', () => {
    const m = manifestSchema.parse({
      kind: 'bundle',
      worker: { digest: 'aa', size: 3 },
      assets: null,
    });
    expect(m.assets).toEqual([]);
    expect(m.cache).toEqual([]);
    expect(m.worker.path).toBe('');
  });

  it('fills a missing worker with a zero BlobInfo', () => {
    const m = manifestSchema.parse({ kind: 'bundle' });
    expect(m.worker).toEqual({ path: '', digest: '', size: 0 });
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

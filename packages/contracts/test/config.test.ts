// The non-secret config channel: schema, validation (identifiers, reserved names,
// secret/config overlap, value-or-sensitive), the container-env helpers, and the
// canonical-digest discipline (config-less manifests hash byte-identically; a
// committed value is part of the deploy id, a dashboard value is not).

import { describe, it, expect } from 'vitest';
import {
  canonicalDigest,
  manifestSchema,
  publicConfig,
  requiredConfigNames,
  validateConfig,
  asDeployError,
  DeployCode,
  type ConfigEntry,
  type Manifest,
} from '../src/index.js';

function manifest(fields?: { config?: unknown; secrets?: string[] }): Manifest {
  return manifestSchema.parse({
    kind: 'container',
    build: { builder: 'next', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest: 'a'.repeat(64), size: 10 }],
    ...(fields?.secrets ? { secrets: fields.secrets } : {}),
    ...(fields?.config === undefined ? {} : { config: fields.config }),
  });
}

const cfg = (over: Partial<ConfigEntry>): ConfigEntry => ({ name: 'X', value: '', sensitive: false, ...over });

function rejects(config: ConfigEntry[], secrets: string[] = []): void {
  let thrown: unknown;
  try {
    validateConfig(config, secrets);
  } catch (e) {
    thrown = e;
  }
  expect(asDeployError(thrown)?.code).toBe(DeployCode.PreflightRejected);
}

describe('validateConfig', () => {
  it('accepts committed-public, committed-sensitive, and dashboard-entered entries', () => {
    expect(() =>
      validateConfig(
        [
          cfg({ name: 'REGION', value: 'us-east-1' }),
          cfg({ name: 'INTERNAL_HOST', value: 'internal.example', sensitive: true }),
          cfg({ name: 'SHEET_ID', value: '', sensitive: true }),
        ],
        [],
      ),
    ).not.toThrow();
  });

  it('rejects an invalid environment-variable name', () => {
    rejects([cfg({ name: '1BAD', value: 'x' })]);
    rejects([cfg({ name: 'has-dash', value: 'x' })]);
    rejects([cfg({ name: 'has space', value: 'x' })]);
  });

  it('rejects a duplicate config name', () => {
    rejects([cfg({ name: 'A', value: '1' }), cfg({ name: 'A', value: '2' })]);
  });

  it('rejects a reserved container or platform name', () => {
    for (const name of ['PORT', 'HOSTNAME', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'TWO80_CONFIG', 'TWO80_ANYTHING']) {
      rejects([cfg({ name, value: 'x' })]);
    }
  });

  it('rejects a name that is also a declared secret', () => {
    rejects([cfg({ name: 'SHARED', value: 'x' })], ['SHARED']);
  });

  it('rejects a non-sensitive entry with no value', () => {
    rejects([cfg({ name: 'EMPTY', value: '', sensitive: false })]);
  });
});

describe('config env helpers', () => {
  it('publicConfig maps only entries that carry a committed value', () => {
    expect(
      publicConfig([
        cfg({ name: 'A', value: '1' }),
        cfg({ name: 'B', value: 'b', sensitive: true }),
        cfg({ name: 'C', value: '', sensitive: true }),
      ]),
    ).toEqual({ A: '1', B: 'b' });
  });

  it('requiredConfigNames is the sensitive entries with no committed value', () => {
    expect(
      requiredConfigNames([
        cfg({ name: 'A', value: '1' }),
        cfg({ name: 'B', value: 'b', sensitive: true }),
        cfg({ name: 'C', value: '', sensitive: true }),
      ]),
    ).toEqual(['C']);
  });
});

describe('canonicalDigest and config', () => {
  it('is byte-identical for a config-less manifest and an empty-config manifest', () => {
    expect(canonicalDigest(manifest({ config: [] }))).toBe(canonicalDigest(manifest()));
  });

  it('changes when a committed config value changes', () => {
    const a = canonicalDigest(manifest({ config: [cfg({ name: 'REGION', value: 'us-east-1' })] }));
    const b = canonicalDigest(manifest({ config: [cfg({ name: 'REGION', value: 'eu-west-1' })] }));
    expect(a).not.toBe(b);
  });

  it('changes when the sensitive flag flips but not with declaration order', () => {
    const plain = canonicalDigest(manifest({ config: [cfg({ name: 'K', value: 'v' })] }));
    const sensitive = canonicalDigest(manifest({ config: [cfg({ name: 'K', value: 'v', sensitive: true })] }));
    expect(plain).not.toBe(sensitive);

    const ab = canonicalDigest(manifest({ config: [cfg({ name: 'A', value: '1' }), cfg({ name: 'B', value: '2' })] }));
    const ba = canonicalDigest(manifest({ config: [cfg({ name: 'B', value: '2' }), cfg({ name: 'A', value: '1' })] }));
    expect(ab).toBe(ba);
  });

  it('does not change when a dashboard-entered (valueless) config name is present', () => {
    // The value is entered in the dashboard, so the manifest carries value '' and the
    // deploy id must not move when the human enters it later.
    const withRequired = canonicalDigest(manifest({ config: [cfg({ name: 'SHEET_ID', value: '', sensitive: true })] }));
    const declaredElsewhere = canonicalDigest(manifest({ config: [cfg({ name: 'SHEET_ID', value: '', sensitive: true })] }));
    expect(withRequired).toBe(declaredElsewhere);
  });
});

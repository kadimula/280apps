// The egress policy wire shape, its type vocabulary, semantic validation, and
// normalization: the allowlist and every credential's transport fields are derived
// in one place, and a policy change re-derives the manifest's canonical digest (so a
// new allowlist/type/scope redeploys). Static manifests keep their byte-for-byte
// digest; typed credentials add records only on departure from the default.

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  egressPolicySchema,
  egressCredentialSchema,
  normalizeEgressPolicy,
  normalizeScopes,
  validateEgressPolicy,
  validateWireEgressPolicy,
  isEgressCredentialType,
  googleServiceAccountHostAllowed,
  isReservedBindingName,
  credentialSecretNames,
  CREDENTIAL_FIELDS,
  EGRESS_CREDENTIAL_TYPE,
  MAX_EGRESS_SCOPES,
  manifestSchema,
  canonicalDigest,
  DeployCode,
  asDeployError,
  type EgressPolicy,
  type Manifest,
} from '../src/index.js';
import { Fake } from '../src/deploy/fake.js';

function manifest(fields?: { egress?: unknown; secrets?: string[] }): Manifest {
  return manifestSchema.parse({
    kind: 'container',
    build: { builder: 'next', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest: 'a'.repeat(64), size: 10 }],
    ...(fields?.secrets ? { secrets: fields.secrets } : {}),
    ...(fields?.egress === undefined ? {} : { egress: fields.egress }),
  });
}

// Drives validation the way the deploy path does: parse to the wire shape, then gate.
function validate(egress: unknown, secrets: string[] = []): void {
  const policy = egressPolicySchema.parse(egress) as EgressPolicy;
  validateEgressPolicy(policy, secrets);
}

const google = (over: Record<string, unknown> = {}) => ({
  host: 'sheets.googleapis.com',
  secret: 'GSA',
  type: EGRESS_CREDENTIAL_TYPE.GoogleServiceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  ...over,
});

// The multi-field form of the same google credential: the two service-account
// values bound under the app's own secret names instead of one blob.
const googleFields = (over: Record<string, unknown> = {}) => ({
  host: 'sheets.googleapis.com',
  type: EGRESS_CREDENTIAL_TYPE.GoogleServiceAccount,
  secrets: { client_email: 'GOOGLE_CLIENT_EMAIL', private_key: 'GOOGLE_PRIVATE_KEY' },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  ...over,
});

describe('egress semantic helpers', () => {
  it('recognizes only the closed type vocabulary', () => {
    expect(isEgressCredentialType('header')).toBe(true);
    expect(isEgressCredentialType('google-service-account')).toBe(true);
    expect(isEgressCredentialType('')).toBe(false);
    expect(isEgressCredentialType('aws-sigv4')).toBe(false);
  });

  it('pins the google host boundary to the label edge, no wildcards', () => {
    expect(googleServiceAccountHostAllowed('googleapis.com')).toBe(true);
    expect(googleServiceAccountHostAllowed('sheets.googleapis.com')).toBe(true);
    expect(googleServiceAccountHostAllowed('SHEETS.GOOGLEAPIS.COM')).toBe(true);
    expect(googleServiceAccountHostAllowed('notgoogleapis.com')).toBe(false);
    expect(googleServiceAccountHostAllowed('googleapis.com.evil.com')).toBe(false);
    expect(googleServiceAccountHostAllowed('*.googleapis.com')).toBe(false);
    expect(googleServiceAccountHostAllowed('.googleapis.com')).toBe(false);
    expect(googleServiceAccountHostAllowed('sheets.googleapis.com/v4')).toBe(false);
  });

  it('reserves the platform binding names and the TWO80_ namespace', () => {
    for (const n of ['APP', 'GATEWAY', 'EGRESS_POLICY', 'TWO80_APP_ID', 'TWO80_ROUTE_POLICY', 'TWO80_ANYTHING']) {
      expect(isReservedBindingName(n)).toBe(true);
    }
    expect(isReservedBindingName('STRIPE_KEY')).toBe(false);
    expect(isReservedBindingName('GSA')).toBe(false);
  });

  it('normalizes scopes: trim, drop empty, dedupe, byte-sort', () => {
    expect(normalizeScopes([' b ', 'a', 'b', '', '  '])).toEqual(['a', 'b']);
  });
});

describe('egress credential schema (presence-preserving)', () => {
  it('keeps transport fields absent rather than defaulting them, so presence survives to validation', () => {
    const c = egressCredentialSchema.parse({ host: 'api.stripe.com', secret: 'STRIPE_KEY' });
    expect(c.header).toBeUndefined();
    expect(c.scheme).toBeUndefined();
    expect(c.type).toBeUndefined();
    expect(c.scopes).toBeUndefined();
  });

  it('preserves an explicit empty scheme (a raw-value header) distinct from absent', () => {
    const c = egressCredentialSchema.parse({ host: 'x.supabase.co', secret: 'SB', header: 'apikey', scheme: '' });
    expect(c).toMatchObject({ header: 'apikey', scheme: '' });
  });
});

describe('normalizeEgressPolicy applies the type-specific transport defaults', () => {
  it('defaults a header credential to bearer-auth and preserves an explicit empty scheme', () => {
    const n = normalizeEgressPolicy(
      egressPolicySchema.parse({
        allowedHosts: [],
        credentials: [
          { host: 'api.stripe.com', secret: 'K' },
          { host: 'x.supabase.co', secret: 'SB', header: 'apikey', scheme: '' },
        ],
      }),
    );
    expect(n.credentials[0]).toMatchObject({ type: 'header', header: 'authorization', scheme: 'Bearer', scopes: [] });
    expect(n.credentials[1]).toMatchObject({ header: 'apikey', scheme: '' });
  });

  it('strips transport fields and normalizes scopes on a typed credential', () => {
    const n = normalizeEgressPolicy(
      egressPolicySchema.parse({
        allowedHosts: [],
        credentials: [google({ scopes: [' b ', 'a', 'b'] })],
      }),
    );
    expect(n.credentials[0]).toMatchObject({
      host: 'sheets.googleapis.com',
      type: 'google-service-account',
      header: '',
      scheme: '',
      scopes: ['a', 'b'],
    });
  });

  it('folds every credential host into the allowlist, lowercases, trims, and dedupes', () => {
    const n = normalizeEgressPolicy(
      egressPolicySchema.parse({
        allowedHosts: ['  API.Stripe.com ', 'api.stripe.com', ''],
        credentials: [{ host: 'X.Supabase.co', secret: 'SB' }],
      }),
    );
    expect(n.allowedHosts).toEqual(['api.stripe.com', 'x.supabase.co']);
    expect(n.credentials[0]!.host).toBe('x.supabase.co');
  });

  it('drops a credential with an empty host', () => {
    const n = normalizeEgressPolicy(
      egressPolicySchema.parse({ allowedHosts: [], credentials: [{ host: '  ', secret: 'X' }] }),
    );
    expect(n.credentials).toEqual([]);
    expect(n.allowedHosts).toEqual([]);
  });
});

describe('canonicalDigest back-compat and typed records', () => {
  it('a static credential emits exactly the pre-typed bytes (byte-for-byte back-compat)', () => {
    const m = manifest({ egress: { credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY' }] } });
    const h = createHash('sha256');
    h.update('kind:container\n');
    h.update('build:next:Dockerfile:8080\n');
    h.update(`file:Dockerfile:${'a'.repeat(64)}:10\n`);
    h.update('egress-host:api.stripe.com\n');
    h.update('egress-cred:api.stripe.com:authorization:Bearer:STRIPE_KEY\n');
    expect(canonicalDigest(m)).toBe(h.digest('hex'));
  });

  it('an empty egress policy is digest-stable regardless of representation', () => {
    expect(canonicalDigest(manifest())).toBe(canonicalDigest(manifest({ egress: { allowedHosts: [], credentials: [] } })));
  });

  it('adding a typed credential departs from the static digest', () => {
    const staticOnly = canonicalDigest(manifest({ egress: { credentials: [{ host: 'api.stripe.com', secret: 'K' }] } }));
    const typed = canonicalDigest(manifest({ egress: { credentials: [google()] } }));
    expect(typed).not.toBe(staticOnly);
  });

  it('scope order and duplicate spelling normalize to one digest', () => {
    const a = canonicalDigest(manifest({ egress: { credentials: [google({ scopes: ['a', 'b'] })] } }));
    const b = canonicalDigest(manifest({ egress: { credentials: [google({ scopes: ['b', 'a', 'a'] })] } }));
    expect(a).toBe(b);
  });

  it('type, scope, secret, and host changes each alter the digest', () => {
    const base = canonicalDigest(manifest({ egress: { credentials: [google()] } }));
    const scope = canonicalDigest(
      manifest({ egress: { credentials: [google({ scopes: ['https://www.googleapis.com/auth/drive'] })] } }),
    );
    const secret = canonicalDigest(manifest({ egress: { credentials: [google({ secret: 'GSA2' })] } }));
    const host = canonicalDigest(manifest({ egress: { credentials: [google({ host: 'drive.googleapis.com' })] } }));
    expect(new Set([base, scope, secret, host]).size).toBe(4);
  });

  it('emits one line per scope (commas in a scope URI never join records)', () => {
    const oneCommaScope = canonicalDigest(manifest({ egress: { credentials: [google({ scopes: ['a,b'] })] } }));
    const twoScopes = canonicalDigest(manifest({ egress: { credentials: [google({ scopes: ['a', 'b'] })] } }));
    expect(oneCommaScope).not.toBe(twoScopes);
  });

  it('a multi-field credential departs from the blob-form digest', () => {
    const blob = canonicalDigest(manifest({ egress: { credentials: [google()] } }));
    const fields = canonicalDigest(manifest({ egress: { credentials: [googleFields()] } }));
    expect(fields).not.toBe(blob);
  });

  it('a field map hashes the same regardless of JSON key order', () => {
    const a = canonicalDigest(
      manifest({ egress: { credentials: [googleFields({ secrets: { client_email: 'CE', private_key: 'PK' } })] } }),
    );
    const b = canonicalDigest(
      manifest({ egress: { credentials: [googleFields({ secrets: { private_key: 'PK', client_email: 'CE' } })] } }),
    );
    expect(a).toBe(b);
  });

  it('changing any field NAME changes the digest', () => {
    const base = canonicalDigest(manifest({ egress: { credentials: [googleFields()] } }));
    const renamed = canonicalDigest(
      manifest({
        egress: { credentials: [googleFields({ secrets: { client_email: 'GOOGLE_CLIENT_EMAIL', private_key: 'PK2' } })] },
      }),
    );
    expect(renamed).not.toBe(base);
  });

  it('leaves the pre-existing blob/header digest byte-identical (no field records)', () => {
    // The already-deployed blob app must hash exactly as before the field form existed.
    const m = manifest({ egress: { credentials: [google()] } });
    const h = createHash('sha256');
    h.update('kind:container\n');
    h.update('build:next:Dockerfile:8080\n');
    h.update(`file:Dockerfile:${'a'.repeat(64)}:10\n`);
    h.update('egress-host:sheets.googleapis.com\n');
    h.update('egress-cred:sheets.googleapis.com:::GSA\n');
    h.update('egress-cred-type:sheets.googleapis.com:google-service-account\n');
    h.update('egress-cred-scope:sheets.googleapis.com:https://www.googleapis.com/auth/spreadsheets\n');
    expect(canonicalDigest(m)).toBe(h.digest('hex'));
  });
});

describe('normalizeCredential handles the multi-field form', () => {
  it('keeps secret empty, sorts the field map, and strips transport fields', () => {
    const n = normalizeEgressPolicy(
      egressPolicySchema.parse({
        allowedHosts: [],
        credentials: [googleFields({ secrets: { private_key: 'PK', client_email: 'CE' } })],
      }),
    );
    expect(n.credentials[0]).toMatchObject({
      host: 'sheets.googleapis.com',
      type: 'google-service-account',
      secret: '',
      header: '',
      scheme: '',
    });
    // Sorted by key so the digest is order-independent.
    expect(Object.entries(n.credentials[0]!.secrets!)).toEqual([
      ['client_email', 'CE'],
      ['private_key', 'PK'],
    ]);
  });

  it('drops any field map from a header credential', () => {
    const n = normalizeEgressPolicy(
      egressPolicySchema.parse({
        allowedHosts: [],
        credentials: [{ host: 'api.stripe.com', secret: 'K' }],
      }),
    );
    expect(n.credentials[0]!.secrets).toBeUndefined();
  });
});

describe('validateEgressPolicy', () => {
  const ok = (egress: unknown, secrets: string[]) => expect(() => validate(egress, secrets)).not.toThrow();
  const rejects = (egress: unknown, secrets: string[]) => {
    let thrown: unknown;
    try {
      validate(egress, secrets);
    } catch (e) {
      thrown = e;
    }
    expect(asDeployError(thrown)?.code).toBe(DeployCode.PreflightRejected);
  };

  it('accepts a well-formed static and a well-formed typed credential', () => {
    ok({ credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY' }] }, ['STRIPE_KEY']);
    ok({ credentials: [google()] }, ['GSA']);
  });

  it('rejects an unknown credential type', () => {
    rejects({ credentials: [{ host: 'api.x.com', secret: 'K', type: 'aws-sigv4' }] }, ['K']);
  });

  it('rejects a typed credential on a wildcard or non-provider host', () => {
    rejects({ credentials: [google({ host: '*.googleapis.com' })] }, ['GSA']);
    rejects({ credentials: [google({ host: 'api.stripe.com' })] }, ['GSA']);
  });

  it('rejects author-supplied transport fields on a typed credential', () => {
    rejects({ credentials: [google({ header: 'authorization' })] }, ['GSA']);
    rejects({ credentials: [google({ scheme: 'Bearer' })] }, ['GSA']);
  });

  it('rejects scopes on a static (header) credential', () => {
    rejects({ credentials: [{ host: 'api.stripe.com', secret: 'K', scopes: ['x'] }] }, ['K']);
  });

  it('rejects a typed credential with no usable scope', () => {
    rejects({ credentials: [google({ scopes: [] })] }, ['GSA']);
    rejects({ credentials: [google({ scopes: ['   '] })] }, ['GSA']);
  });

  it('rejects a scope containing whitespace or control characters', () => {
    rejects({ credentials: [google({ scopes: ['read write'] })] }, ['GSA']);
    rejects({ credentials: [google({ scopes: ['read\tsheets'] })] }, ['GSA']);
    rejects({ credentials: [google({ scopes: ['read\nsheets'] })] }, ['GSA']);
  });

  it('rejects more than the scope count limit', () => {
    const scopes = Array.from({ length: MAX_EGRESS_SCOPES + 1 }, (_, i) => `https://scope/${i}`);
    rejects({ credentials: [google({ scopes })] }, ['GSA']);
  });

  it('rejects duplicate credential hosts', () => {
    rejects(
      {
        credentials: [
          { host: 'api.stripe.com', secret: 'A' },
          { host: 'API.Stripe.com', secret: 'B' },
        ],
      },
      ['A', 'B'],
    );
  });

  it('self-declares a credential secret absent from the top-level secrets list', () => {
    // Leanness: binding a host to a secret is what declares it, so it need not be
    // repeated in "secrets". The reserved-name check still applies (below).
    ok({ credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY' }] }, []);
  });

  it('rejects a credential with no secret name', () => {
    rejects({ credentials: [{ host: 'api.stripe.com', secret: '' }] }, []);
  });

  it('rejects a secret that collides with a reserved binding name', () => {
    rejects({ credentials: [{ host: 'api.stripe.com', secret: 'EGRESS_POLICY' }] }, ['EGRESS_POLICY']);
  });

  it('accepts a multi-field typed credential, self-declaring both field names', () => {
    ok({ credentials: [googleFields()] }, []);
  });

  it('rejects a typed credential that sets both secret and secrets', () => {
    rejects({ credentials: [googleFields({ secret: 'GSA' })] }, ['GSA']);
  });

  it('rejects a typed credential that sets neither secret nor secrets', () => {
    rejects({ credentials: [google({ secret: '' })] }, []);
  });

  it('rejects a field map missing a required key', () => {
    rejects({ credentials: [googleFields({ secrets: { client_email: 'GOOGLE_CLIENT_EMAIL' } })] }, []);
  });

  it('rejects a field map with an unknown key', () => {
    rejects(
      {
        credentials: [
          googleFields({
            secrets: { client_email: 'A', private_key: 'B', project_id: 'C' },
          }),
        ],
      },
      [],
    );
  });

  it('rejects a field NAME that collides with a reserved binding name', () => {
    rejects({ credentials: [googleFields({ secrets: { client_email: 'A', private_key: 'EGRESS_POLICY' } })] }, []);
  });

  it('rejects two fields pointing at the same secret NAME', () => {
    rejects({ credentials: [googleFields({ secrets: { client_email: 'DUP', private_key: 'DUP' } })] }, []);
  });

  it('rejects a field NAME that is empty', () => {
    rejects({ credentials: [googleFields({ secrets: { client_email: 'A', private_key: '' } })] }, []);
  });

  it('rejects a "secrets" field map on a header credential', () => {
    rejects(
      { credentials: [{ host: 'api.stripe.com', secrets: { client_email: 'A', private_key: 'B' } }] },
      [],
    );
  });
});

describe('credentialSecretNames', () => {
  it('lists the single secret for a blob credential', () => {
    expect(credentialSecretNames(egressCredentialSchema.parse({ host: 'x', secret: 'K' }))).toEqual(['K']);
  });

  it('lists the field NAMEs in fixed vocabulary order for a multi-field credential', () => {
    const c = egressCredentialSchema.parse(googleFields());
    expect(credentialSecretNames(c)).toEqual(['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY']);
  });

  it('is independent of the JSON key order the author wrote', () => {
    const c = egressCredentialSchema.parse(
      googleFields({ secrets: { private_key: 'PK', client_email: 'CE' } }),
    );
    expect(credentialSecretNames(c)).toEqual(['CE', 'PK']); // client_email before private_key
  });

  it('returns [] for an allowlisted host with no credential', () => {
    expect(credentialSecretNames(egressCredentialSchema.parse({ host: 'x', secret: '' }))).toEqual([]);
  });

  it('pins the google field vocabulary', () => {
    expect(CREDENTIAL_FIELDS[EGRESS_CREDENTIAL_TYPE.GoogleServiceAccount]).toEqual(['client_email', 'private_key']);
  });
});

describe('validateWireEgressPolicy accepts the normalized form the CLI actually sends', () => {
  const wire = (egress: unknown): EgressPolicy =>
    normalizeEgressPolicy(egressPolicySchema.parse(egress) as EgressPolicy);

  it('accepts a normalized static credential that the raw gate rejects', () => {
    const w = wire({ allowedHosts: [], credentials: [{ host: 'api.stripe.com', secret: 'K', header: 'authorization', scheme: 'Bearer' }] });
    // normalizeEgressPolicy baked scopes:[] onto the header credential; the raw gate
    // reads presence and rejects that, the wire gate restores it and accepts.
    expect(() => validateEgressPolicy(w, ['K'])).toThrow();
    expect(() => validateWireEgressPolicy(w, ['K'])).not.toThrow();
  });

  it('accepts a normalized google credential that the raw gate rejects', () => {
    const w = wire({ allowedHosts: [], credentials: [google()] });
    // normalizeEgressPolicy baked header:''/scheme:'' onto the typed credential.
    expect(() => validateEgressPolicy(w, ['GSA'])).toThrow();
    expect(() => validateWireEgressPolicy(w, ['GSA'])).not.toThrow();
  });

  it('still rejects security-relevant violations that survive normalization', () => {
    const badHost = wire({ allowedHosts: [], credentials: [google({ host: 'api.stripe.com' })] });
    expect(() => validateWireEgressPolicy(badHost, ['GSA'])).toThrow();
    // A credential secret is self-declared, so an empty secrets list is fine.
    const selfDeclared = wire({ allowedHosts: [], credentials: [google()] });
    expect(() => validateWireEgressPolicy(selfDeclared, [])).not.toThrow();
  });

  it('accepts a normalized multi-field credential (the field map survives normalization)', () => {
    const w = wire({ allowedHosts: [], credentials: [googleFields()] });
    expect(() => validateWireEgressPolicy(w, [])).not.toThrow();
  });
});

describe('the fake preflight rejects the same typed policy errors as the backend', () => {
  const identity = { appId: '', slug: 'demo', framework: 'next', gitRemote: '', clientRef: '', forceNew: false };
  const sync = (egress: unknown, secrets: string[]) =>
    new Fake().sync({
      identity,
      manifest: manifest({ egress, secrets }),
    });

  it('lets a well-formed typed policy through preflight', async () => {
    await expect(sync({ credentials: [google()] }, ['GSA'])).resolves.toMatchObject({ resolution: 'created' });
  });

  it('accepts a typed credential whose secret is not in the top-level secrets list', async () => {
    // The credential self-declares its secret; leanness means no duplicate listing.
    await expect(sync({ credentials: [google()] }, [])).resolves.toMatchObject({ resolution: 'created' });
  });

  it('rejects a typed credential on a non-provider host with PreflightRejected', async () => {
    await expect(sync({ credentials: [google({ host: 'api.stripe.com' })] }, ['GSA'])).rejects.toMatchObject({
      code: DeployCode.PreflightRejected,
    });
  });
});

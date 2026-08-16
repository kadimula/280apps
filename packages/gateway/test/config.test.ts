import { describe, expect, it } from 'vitest';
import { readConfig, type Env } from '../src/config.js';

function env(values: Partial<Env> = {}): Env {
  return { HYPERDRIVE: { connectionString: 'postgres://database' } as Hyperdrive, ...values };
}

describe('gateway runtime configuration', () => {
  it('derives production configuration from canonical domains', () => {
    const config = readConfig(env({ PLATFORM_DOMAIN: '280apps.com', APP_SERVING_DOMAIN: '280apps.run' }));
    expect(config.authHost).toBe('auth.280apps.run');
    expect(config.authOrigin).toBe('https://auth.280apps.run');
    expect(config.idIssuer).toBe(config.authOrigin);
    expect(config.cookieDomain).toBe('.280apps.run');
    expect(config.fallbackRedirect).toBe('https://280apps.com');
  });

  it('derives development configuration from one environment name', () => {
    const config = readConfig(
      env({
        DEPLOYMENT_ENVIRONMENT: 'development',
        PLATFORM_DOMAIN: '280apps.com',
        APP_SERVING_DOMAIN: '280apps.run',
      }),
    );
    expect(config.hostSuffix).toBe('-development');
    expect(config.authHost).toBe('auth-development.280apps.run');
    expect(config.idIssuer).toBe('https://auth-development.280apps.run');
    expect(config.fallbackRedirect).toBe('https://development.280apps.com');
  });

  it('reads descriptive OIDC and signing credential names', () => {
    const config = readConfig(
      env({
        GOOGLE_OIDC_CLIENT_ID: 'google-id',
        GOOGLE_OIDC_CLIENT_SECRET: 'google-secret',
        MICROSOFT_ENTRA_OIDC_CLIENT_ID: 'entra-id',
        MICROSOFT_ENTRA_OIDC_CLIENT_SECRET: 'entra-secret',
        IDENTITY_SIGNING_PRIVATE_JWK: '{"kty":"EC"}',
      }),
    );
    expect(config.google).toEqual({ clientId: 'google-id', clientSecret: 'google-secret' });
    expect(config.entra).toEqual({ clientId: 'entra-id', clientSecret: 'entra-secret' });
    expect(config.idSigningJwk).toBe('{"kty":"EC"}');
  });
});

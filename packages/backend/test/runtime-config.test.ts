import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';

describe('backend runtime configuration', () => {
  it('derives production configuration from canonical domains', () => {
    const config = resolveConfig(
      { PLATFORM_DOMAIN: '280apps.com', APP_SERVING_DOMAIN: '280apps.run' },
      'postgres://database',
    );
    expect(config.apiOrigin).toBe('https://api.280apps.com');
    expect(config.sdkApiOrigin).toBe('https://api.280apps.com');
    expect(config.dashboardOrigin).toBe('https://280apps.com');
    expect(config.activationUrl).toBe('https://280apps.com/activate');
    expect(config.frameAncestors).toBe('https://280apps.com');
    expect(config.gatewayService).toBe('280-gateway');
    expect(config.authOrigin).toBe('https://auth.280apps.run');
    expect(config.cookieDomain).toBe('.280apps.com');
    expect(config.sessionCookieName).toBe('280_session');
  });

  it('derives isolated development configuration from Railway', () => {
    const config = resolveConfig(
      {
        RAILWAY_ENVIRONMENT_NAME: 'development',
        PLATFORM_DOMAIN: '280apps.com',
        APP_SERVING_DOMAIN: '280apps.run',
        ADDITIONAL_FRAME_ANCESTORS: 'https://embed.example.com',
      },
      'postgres://database',
    );
    expect(config.apiOrigin).toBe('https://api-development.280apps.com');
    expect(config.dashboardOrigin).toBe('https://development.280apps.com');
    expect(config.activationUrl).toBe('https://development.280apps.com/activate');
    expect(config.frameAncestors).toBe('https://development.280apps.com https://embed.example.com');
    expect(config.gatewayService).toBe('280-gateway-development');
    expect(config.authOrigin).toBe('https://auth-development.280apps.run');
    expect(config.sessionCookieName).toBe('280_session_development');
    expect(config.oauthCookieName).toBe('280_oauth_development');
  });

  it('lets local-dev overrides point the login flow at localhost origins', () => {
    const config = resolveConfig(
      {
        PLATFORM_DOMAIN: '280apps.com',
        APP_SERVING_DOMAIN: '280apps.run',
        TWO80_API_ORIGIN: 'http://localhost:8080',
        TWO80_DASHBOARD_ORIGIN: 'http://localhost:3000',
        TWO80_COOKIE_DOMAIN: '',
      },
      'postgres://database',
    );
    expect(config.apiOrigin).toBe('http://localhost:8080');
    expect(config.dashboardOrigin).toBe('http://localhost:3000');
    expect(config.activationUrl).toBe('http://localhost:3000/activate');
    expect(config.frameAncestors).toBe('http://localhost:3000');
    expect(config.cookieDomain).toBe('');
    // sdkApiOrigin must stay a real HTTPS origin, decoupled from the localhost
    // login origin, so the container builder's exact-HTTPS check never fatals.
    expect(config.sdkApiOrigin).toBe('https://api.280apps.com');
  });

  it('takes the SDK API origin from TWO80_SDK_API_ORIGIN, independent of the login origin', () => {
    const config = resolveConfig(
      {
        PLATFORM_DOMAIN: '280apps.com',
        APP_SERVING_DOMAIN: '280apps.run',
        TWO80_API_ORIGIN: 'http://localhost:8080',
        TWO80_SDK_API_ORIGIN: 'https://api-development.280apps.com',
      },
      'postgres://database',
    );
    expect(config.apiOrigin).toBe('http://localhost:8080');
    expect(config.sdkApiOrigin).toBe('https://api-development.280apps.com');
  });

  it('sources the roll worker entry from APP_WORKER_ENTRYPOINT, not the bare basename', () => {
    // Regression guard for PR #85: the roll runs wrangler in a lone temp dir, so
    // workerEntry must be the absolute vendored path the Dockerfile exports, never
    // the 'worker.js' basename that resolves to nothing there.
    const config = resolveConfig(
      { APP_WORKER_ENTRYPOINT: '/app/appcontainer/src/worker.js' },
      'postgres://database',
    );
    expect(config.workerEntry).toBe('/app/appcontainer/src/worker.js');
  });

  it('falls back to the platform-policy basename only when APP_WORKER_ENTRYPOINT is unset or blank', () => {
    expect(resolveConfig({}, 'postgres://database').workerEntry).toBe('worker.js');
    expect(resolveConfig({ APP_WORKER_ENTRYPOINT: '  ' }, 'postgres://database').workerEntry).toBe('worker.js');
  });

  it('reads only purpose-specific credential names', () => {
    const config = resolveConfig(
      {
        GOOGLE_OIDC_CLIENT_ID: 'google-id',
        GOOGLE_OIDC_CLIENT_SECRET: 'google-secret',
        DEPOT_BUILD_PROJECT_ID: 'depot-project',
        DEPOT_API_TOKEN: 'depot-token',
        CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account',
        CLOUDFLARE_DEPLOY_API_TOKEN: 'cloudflare-token',
      },
      'postgres://database',
    );
    expect(config.google).toEqual({ clientId: 'google-id', clientSecret: 'google-secret' });
    expect(config.depot).toEqual({ projectId: 'depot-project', token: 'depot-token' });
    expect(config.cloudflare).toEqual({ accountId: 'cloudflare-account', apiToken: 'cloudflare-token' });
  });
});

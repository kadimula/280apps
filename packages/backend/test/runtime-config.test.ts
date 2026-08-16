import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';

describe('backend runtime configuration', () => {
  it('derives production configuration from canonical domains', () => {
    const config = resolveConfig(
      { PLATFORM_DOMAIN: '280apps.com', APP_SERVING_DOMAIN: '280apps.run' },
      'postgres://database',
    );
    expect(config.apiOrigin).toBe('https://api.280apps.com');
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

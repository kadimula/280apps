import { describe, expect, it } from 'vitest';
import { resolvePlatformTopology } from '../src/platform-config.js';

describe('platform topology', () => {
  it('derives production hosts and cookies from two domains', () => {
    expect(resolvePlatformTopology({})).toEqual({
      environment: 'production',
      platformDomain: '280apps.com',
      appServingDomain: '280apps.run',
      hostSuffix: '',
      dashboardOrigin: 'https://280apps.com',
      apiOrigin: 'https://api.280apps.com',
      activationUrl: 'https://280apps.com/activate',
      backendCookieDomain: '.280apps.com',
      gatewayCookieDomain: '.280apps.run',
      sessionCookieName: '280_session',
      oauthCookieName: '280_oauth',
      authHost: 'auth.280apps.run',
      authOrigin: 'https://auth.280apps.run',
      gatewayService: '280-gateway',
    });
  });

  it('derives an isolated development topology', () => {
    const config = resolvePlatformTopology({ environment: 'development' });
    expect(config.dashboardOrigin).toBe('https://development.280apps.com');
    expect(config.apiOrigin).toBe('https://api-development.280apps.com');
    expect(config.activationUrl).toBe('https://development.280apps.com/activate');
    expect(config.hostSuffix).toBe('-development');
    expect(config.authOrigin).toBe('https://auth-development.280apps.run');
    expect(config.gatewayService).toBe('280-gateway-development');
    expect(config.sessionCookieName).toBe('280_session_development');
    expect(config.oauthCookieName).toBe('280_oauth_development');
  });

  it('rejects origins and malformed environment names', () => {
    expect(() => resolvePlatformTopology({ platformDomain: 'https://280apps.com' })).toThrow('PLATFORM_DOMAIN');
    expect(() => resolvePlatformTopology({ environment: 'pull/request' })).toThrow('deployment environment');
  });
});

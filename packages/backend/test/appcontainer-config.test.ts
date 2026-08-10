// The container harness's TWO80_CONFIG decoder (platform/appcontainer). It is the
// last hop of the config channel: the roll bakes TWO80_CONFIG, App280Container's
// constructor decodes it into process.env. Tested here because platform/appcontainer
// is not a workspace package with its own runner; the decoder is dependency-free.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  ContainerProxy: class {},
}));

import { parseConfig, parseSdkApi } from '../../../platform/appcontainer/src/config.js';
import { App280Container } from '../../../platform/appcontainer/src/container.js';

describe('appcontainer parseConfig', () => {
  it('decodes a flat string map', () => {
    expect(parseConfig(JSON.stringify({ REGION: 'us-east-1', SHEET_ID: 'abc' }))).toEqual({
      REGION: 'us-east-1',
      SHEET_ID: 'abc',
    });
  });

  it('returns {} for an absent, empty, or malformed var', () => {
    expect(parseConfig(undefined)).toEqual({});
    expect(parseConfig('')).toEqual({});
    expect(parseConfig('not json')).toEqual({});
    expect(parseConfig('[1,2,3]')).toEqual({});
    expect(parseConfig('null')).toEqual({});
    expect(parseConfig('"a string"')).toEqual({});
  });

  it('drops non-string values so nothing but strings reach process.env', () => {
    expect(parseConfig(JSON.stringify({ OK: 'v', N: 5, B: true, O: { x: 1 }, A: ['x'] }))).toEqual({ OK: 'v' });
  });
});

describe('App280Container network boundary', () => {
  it('permits only the SDK API host and injects its origin', () => {
    const container = new App280Container({}, {
      TWO80_SDK_API_ORIGIN: 'https://api.280apps.com',
      TWO80_CONFIG: JSON.stringify({ REGION: 'us-east-1' }),
    });
    expect(container.enableInternet).toBe(false);
    expect(container.interceptHttps).toBe(true);
    expect(container.allowedHosts).toEqual(['api.280apps.com']);
    expect(container.envVars).toEqual({ REGION: 'us-east-1', TWO80_API: 'https://api.280apps.com' });
  });

  it('allows nothing when the platform origin is malformed', () => {
    const container = new App280Container({}, { TWO80_SDK_API_ORIGIN: 'https://*.280apps.com' });
    expect(container.enableInternet).toBe(false);
    expect(container.allowedHosts).toEqual([]);
    expect(container.envVars).not.toHaveProperty('TWO80_API');
  });
});

describe('appcontainer parseSdkApi', () => {
  it('returns the one exact HTTPS origin and hostname', () => {
    expect(parseSdkApi('https://api.280apps.com')).toEqual({
      origin: 'https://api.280apps.com',
      host: 'api.280apps.com',
    });
  });

  it('fails closed for malformed or broadened destinations', () => {
    for (const value of ['', 'not a url', 'http://api.280apps.com', 'https://user@api.280apps.com', 'https://api.280apps.com/v1', 'https://*.280apps.com']) {
      expect(parseSdkApi(value)).toEqual({ origin: '', host: '' });
    }
  });
});

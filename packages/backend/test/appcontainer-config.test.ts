// The container harness's TWO80_CONFIG decoder (platform/appcontainer). It is the
// last hop of the config channel: the roll bakes TWO80_CONFIG, App280Container's
// constructor decodes it into process.env. Tested here because platform/appcontainer
// is not a workspace package with its own runner; the decoder is dependency-free.

import { describe, it, expect } from 'vitest';

import { parseConfig, parseSecrets, parseSdkApi } from '../../../platform/appcontainer/src/config.js';
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

describe('appcontainer parseSecrets', () => {
  it('forwards only the named Worker secret bindings, dropping non-strings', () => {
    const env = { STRIPE_KEY: 'sk_live', DB_URL: 'postgres://x', NOISE: 'ignored', N: 5 };
    expect(parseSecrets(env, JSON.stringify(['STRIPE_KEY', 'DB_URL', 'MISSING', 'N']))).toEqual({
      STRIPE_KEY: 'sk_live',
      DB_URL: 'postgres://x',
    });
  });

  it('returns {} for an absent, empty, or malformed names manifest', () => {
    const env = { A: 'v' };
    for (const raw of [undefined, '', 'not json', '{"A":"v"}', '[1,2]']) {
      expect(parseSecrets(env, raw)).toEqual({});
    }
  });
});

describe('App280Container network boundary', () => {
  it('reaches the internet directly and injects config, secrets, and the SDK origin', () => {
    const container = new App280Container({}, {
      TWO80_SDK_API_ORIGIN: 'https://api.280apps.com',
      TWO80_CONFIG: JSON.stringify({ REGION: 'us-east-1' }),
      TWO80_SECRET_NAMES: JSON.stringify(['STRIPE_KEY']),
      STRIPE_KEY: 'sk_live_x',
    });
    expect(container.enableInternet).toBe(true);
    expect(container.allowedHosts).toBeUndefined();
    expect(container.envVars).toEqual({
      REGION: 'us-east-1',
      STRIPE_KEY: 'sk_live_x',
      TWO80_API: 'https://api.280apps.com',
    });
  });

  it('injects no TWO80_API when the platform origin is malformed, but still reaches the internet', () => {
    const container = new App280Container({}, { TWO80_SDK_API_ORIGIN: 'https://*.280apps.com' });
    expect(container.enableInternet).toBe(true);
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

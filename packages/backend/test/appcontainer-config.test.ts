// The container harness's TWO80_CONFIG decoder (platform/appcontainer). It is the
// last hop of the config channel: the roll bakes TWO80_CONFIG, App280Container's
// constructor decodes it into process.env. Tested here because platform/appcontainer
// is not a workspace package with its own runner; the decoder is dependency-free.

import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../../platform/appcontainer/src/config.js';

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

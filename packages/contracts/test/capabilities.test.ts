import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CATALOG,
  CAPABILITY_CATALOG_VERSION,
  capabilityNames,
  capabilityOperations,
  isCapabilitySupported,
  isOperationSupported,
} from '../src/capabilities.js';

describe('capability catalog', () => {
  it('carries a catalog version', () => {
    expect(CAPABILITY_CATALOG_VERSION).toBe('1.0.0');
  });

  it('maps google-sheets to exactly its supported operations', () => {
    expect(CAPABILITY_CATALOG['google-sheets']).toEqual(['read', 'append', 'update', 'deleteRows']);
    expect(capabilityOperations('google-sheets')).toEqual(['read', 'append', 'update', 'deleteRows']);
  });

  it('lists the catalog capabilities', () => {
    expect(capabilityNames()).toEqual(['google-sheets']);
  });

  it('recognizes known capabilities and rejects unknown ones', () => {
    expect(isCapabilitySupported('google-sheets')).toBe(true);
    expect(isCapabilitySupported('dropbox')).toBe(false);
  });

  it('answers operation support without throwing', () => {
    expect(isOperationSupported('google-sheets', 'deleteRows')).toBe(true);
    expect(isOperationSupported('google-sheets', 'read')).toBe(true);
    expect(isOperationSupported('google-sheets', 'purge')).toBe(false);
    expect(isOperationSupported('dropbox', 'read')).toBe(false);
  });
});

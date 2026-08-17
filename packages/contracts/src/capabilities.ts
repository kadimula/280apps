// The versioned vocabulary of integration capabilities and the operations each
// supports. Single source of truth for docs generation, the CLI preflight, and
// manifest validation; carries no provider credentials or provider runtime detail.

export const CAPABILITY_CATALOG_VERSION = '1.0.0';

export const CAPABILITY_CATALOG = {
  'google-sheets': ['read', 'append', 'update', 'deleteRows'],
} as const satisfies Record<string, readonly string[]>;

export type CapabilityName = keyof typeof CAPABILITY_CATALOG;
export type Operation = (typeof CAPABILITY_CATALOG)[CapabilityName][number];

export function capabilityNames(): CapabilityName[] {
  return Object.keys(CAPABILITY_CATALOG) as CapabilityName[];
}

export function isCapabilitySupported(name: string): name is CapabilityName {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_CATALOG, name);
}

export function capabilityOperations(name: CapabilityName): readonly Operation[] {
  return CAPABILITY_CATALOG[name];
}

export function isOperationSupported(capability: string, operation: string): boolean {
  return isCapabilitySupported(capability) && (CAPABILITY_CATALOG[capability] as readonly string[]).includes(operation);
}

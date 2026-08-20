import type { IntegrationResource, Store } from '../seams.js';

// The single alias↔resource join predicate. A requirement is "met" when a resource
// with the same capability and alias is bound. Store faults fail safe (null, i.e.
// unbound), so a transient error never lets a deploy roll out unverified. Shared by
// the deploy gate (missingRequirements, the activator park) and the dashboard's slots
// view so the two agree by construction.
export function boundResource(
  store: Store,
  appId: string,
  req: { capability: string; alias: string },
): Promise<IntegrationResource | null> {
  return store.resourceByAlias(appId, req.capability, req.alias).catch(() => null);
}

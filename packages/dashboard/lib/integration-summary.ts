import type { IntegrationCatalog, IntegrationSlot } from "@/lib/integrations";

// "attention" folds both unconnected cases into one: the provider is not
// connected, or it is connected but a requested slot has no binding. "none" is an
// app that requests nothing; "unknown" is an unreachable platform.
export type IntegrationReadiness = "ready" | "attention" | "none" | "unknown";

export type IntegrationSummary = {
  readiness: IntegrationReadiness;
  connected: boolean;
  slots: IntegrationSlot[];
  unmet: IntegrationSlot[];
  label: string;
};

// The one place integration readiness is decided. The dashboard header, the
// settings gear badge, and the integrations panel all read this rather than
// re-deriving from the catalog, so they can never disagree.
export function integrationSummary(catalog: IntegrationCatalog | null): IntegrationSummary {
  const slots = catalog?.slots ?? [];
  const connected = (catalog?.connections.length ?? 0) > 0;
  const unmet = slots.filter((s) => s.binding === null);
  const label = providerLabel(slots[0]);
  const readiness: IntegrationReadiness = !catalog
    ? "unknown"
    : slots.length === 0
      ? "none"
      : connected && unmet.length === 0
        ? "ready"
        : "attention";
  return { readiness, connected, slots, unmet, label };
}

function providerLabel(slot?: IntegrationSlot): string {
  if (!slot) return "this integration";
  if (slot.capability === "google-sheets" || slot.provider === "google") return "Google Sheets";
  const base = slot.capability || slot.provider;
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/[-_]/g, " ");
}

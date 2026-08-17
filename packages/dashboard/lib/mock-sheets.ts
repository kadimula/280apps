// The spreadsheets the mock Picker offers and the mock backend resolves display
// names from, so the connect → pick → alias flow works with no Google reachable.
// A development aid, mirrored by the real Drive Picker in a live environment.
export type PickedSheet = { id: string; name: string };

export const MOCK_SHEETS: PickedSheet[] = [
  { id: "sheet_orders", name: "Orders" },
  { id: "sheet_inventory", name: "Inventory 2026" },
  { id: "sheet_signups", name: "Beta Signups" },
];

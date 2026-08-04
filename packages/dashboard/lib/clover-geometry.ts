// The single source of truth for the 280 clover mark's shape, used by the in-app
// logo (components/clover-mark.tsx). The committed favicon assets (app/icon.svg,
// app/apple-icon.png, app/favicon.ico) were generated from these same values.
//
// A four-leaf clover: four identical teardrop petals scaled to 0.80 of full size
// about the center (12,12), so their tips meet at the center and reach only 80%
// of the way out toward the four corners, leaving a tighter leaf cluster. A small
// core disc plugs the junction, and a tall sharp arrowhead floats just below it as
// the stem, pointing up toward the leaves. Authored in a 24x24 box.

// One teardrop petal, tip at the center, bulging "north", scaled to 0.80 about
// (12,12) (every point p -> 12 + 0.80*(p - 12)). Rotated into place.
export const CLOVER_PETAL =
  "M12 12 C9.6 10.4 8.96 7.2 10.72 5.76 C11.52 5.12 12.48 5.12 13.28 5.76 C15.04 7.2 14.4 10.4 12 12 Z";

// The four corner placements for the petals (degrees, rotated about the center).
export const PETAL_ANGLES = [45, 135, 225, 315] as const;

// Solid disc that plugs the small gap where the four petal tips meet, sized down
// slightly to stay in proportion with the smaller petals.
export const CLOVER_CORE = { cx: 12, cy: 12, r: 1.95 } as const;

// The stem: a tall sharp arrowhead. A straight-sided spire from the apex
// (12,15.25) down to the right barb, with a concave back edge curving up to a
// center notch and back down to the left barb, so it reads as an arrowhead
// pointing up toward the leaf cluster it floats just below.
export const CLOVER_WEDGE = "M12 15.25 L13.98 22.07 Q12 21.2 10.02 22.07 Z";

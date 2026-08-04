import {
  CLOVER_CORE,
  CLOVER_PETAL,
  CLOVER_WEDGE,
  PETAL_ANGLES,
} from "@/lib/clover-geometry";

// The 280 clover logo. Renders in the current text color and scales to its box,
// so callers style it purely through `className` (size + color). The shape lives
// in @/lib/clover-geometry so the favicon can share it.
export function CloverMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      {PETAL_ANGLES.map((a) => (
        <path key={a} d={CLOVER_PETAL} transform={`rotate(${a} 12 12)`} />
      ))}
      <circle cx={CLOVER_CORE.cx} cy={CLOVER_CORE.cy} r={CLOVER_CORE.r} />
      <path d={CLOVER_WEDGE} />
    </svg>
  );
}

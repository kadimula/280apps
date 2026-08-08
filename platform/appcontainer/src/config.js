// parseConfig decodes TWO80_CONFIG (the plaintext Worker var the roll bakes, a JSON
// object of string→string) into the container env map App280Container starts with.
// Anything that is not a flat string map is dropped to {} so a malformed or hostile
// var can never crash container start or smuggle non-string values into process.env.
// Dependency-free on purpose: it is the one piece of the container harness that is
// unit-testable without the Workers runtime.
export function parseConfig(raw) {
  if (typeof raw !== 'string' || raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

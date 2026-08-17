export function objectSection(obj: Record<string, unknown>, key: string, file: string): Record<string, unknown> {
  const value = obj[key];
  if (value === undefined) return (obj[key] = {}) as Record<string, unknown>;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`refusing to modify ${file}: "${key}" is not an object`);
  }
  return value as Record<string, unknown>;
}
export function arraySection<T>(obj: Record<string, unknown>, key: string, file: string, label = key): T[] {
  const value = obj[key];
  if (value === undefined) return (obj[key] = []) as T[];
  if (!Array.isArray(value)) throw new Error(`refusing to modify ${file}: ${label} is not an array`);
  return value as T[];
}

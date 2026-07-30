// Tiny line-preserving editor (no TOML parser, no runtime dep) that ensures
// `[features].hooks = true` in config.toml touching only that one key, so it
// cannot corrupt the rest of the file. Understands the `[features]` table form
// and the dotted `features.hooks` form; an inline `features = { ... }` table is
// out of scope and rejected (a second [features] table would be a TOML error).

// Guaranteed to leave `features.hooks = true` present, reporting whether it
// changed. Idempotent: an already-true value returns the input unchanged.
export function ensureFeaturesHooks(input: string): { text: string; changed: boolean } {
  if (input.trim() === '') return { text: '[features]\nhooks = true\n', changed: true };

  const hadTrailingNewline = input.endsWith('\n');
  const lines = input.split('\n');
  // Drop the empty final element a trailing newline leaves; framing is re-added.
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop();

  let section = '';
  let featuresHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = tableHeader(line);
    if (header !== null) {
      section = header;
      if (header === 'features') featuresHeaderIdx = i;
      continue;
    }
    const kv = keyValue(line);
    if (!kv) continue;
    const dotted = section === '' ? kv.key : `${section}.${kv.key}`;
    if (section === '' && kv.key === 'features' && kv.value.startsWith('{')) {
      throw new Error('refusing to modify config.toml: `features` is an inline table; set features.hooks = true by hand');
    }
    if (dotted === 'features.hooks') {
      if (kv.value === 'true') return { text: input, changed: false };
      lines[i] = `${kv.indent}${kv.key} = true${kv.trailing ? ' ' + kv.trailing : ''}`;
      return { text: frame(lines, hadTrailingNewline), changed: true };
    }
  }

  if (featuresHeaderIdx >= 0) {
    lines.splice(featuresHeaderIdx + 1, 0, 'hooks = true');
    return { text: frame(lines, hadTrailingNewline), changed: true };
  }
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  lines.push('[features]', 'hooks = true');
  // Appended table always ends the file with a newline, even without one before.
  return { text: frame(lines, true), changed: true };
}

function frame(lines: string[], trailingNewline: boolean): string {
  const body = lines.join('\n');
  return trailingNewline ? body + '\n' : body;
}

// Section name for a `[section]` line, or null; `[[x]]` array-of-tables also null.
function tableHeader(line: string): string | null {
  const m = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
  return m ? m[1]!.trim() : null;
}

interface KV {
  indent: string;
  key: string;
  value: string; // value with any inline comment stripped, trimmed
  trailing: string; // the inline comment (with #) or ''
}

// Parses `key = value`; intentionally shallow, enough to rewrite a boolean flag.
function keyValue(line: string): KV | null {
  const m = /^(\s*)([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
  if (!m) return null;
  const rhs = m[3]!;
  const hash = rhs.indexOf('#');
  const value = (hash >= 0 ? rhs.slice(0, hash) : rhs).trim();
  const trailing = hash >= 0 ? rhs.slice(hash).trim() : '';
  return { indent: m[1]!, key: m[2]!, value, trailing };
}

// toml is a deliberately tiny, line-preserving editor for the one mutation Codex
// setup needs: ensure `[features].hooks = true` in config.toml without a full
// TOML parser (no runtime dep) and without ever rewriting the rest of the file.
// It only touches the single key — every comment, key, and section around it is
// left byte-for-byte intact — so it cannot corrupt an existing config. It
// understands the two ways that key is written in practice: a `[features]` table
// with a `hooks` key, and a top-level dotted `features.hooks` key. Anything more
// exotic (inline table `features = { hooks = true }`) is out of scope; setup
// falls back to appending a fresh `[features]` table, which TOML forbids
// duplicating — hence the inline-table guard below returns a clear error.

// ensureFeaturesHooks returns the file text with `features.hooks = true`
// guaranteed present, and whether it changed. Idempotent: an already-true value
// returns the input unchanged.
export function ensureFeaturesHooks(input: string): { text: string; changed: boolean } {
  // A new or blank file gets a clean, minimal table.
  if (input.trim() === '') return { text: '[features]\nhooks = true\n', changed: true };

  const hadTrailingNewline = input.endsWith('\n');
  const lines = input.split('\n');
  // split on a trailing newline leaves a final '' element; drop it so we operate
  // on real lines and re-add framing at the end.
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop();

  let section = '';
  let featuresHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = tableHeader(line);
    if (header !== null) {
      section = header;
      if (header === 'features') featuresHeaderIdx = i;
      // Guard: an inline `features = { ... }` root key would collide with a new
      // [features] table. Detected below via key parsing, not here.
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
      // Rebuild the assignment preserving indent and any inline comment.
      lines[i] = `${kv.indent}${kv.key} = true${kv.trailing ? ' ' + kv.trailing : ''}`;
      return { text: frame(lines, hadTrailingNewline), changed: true };
    }
  }

  // No existing key. Insert into an existing [features] table, or append one.
  if (featuresHeaderIdx >= 0) {
    lines.splice(featuresHeaderIdx + 1, 0, 'hooks = true');
    return { text: frame(lines, hadTrailingNewline), changed: true };
  }
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  lines.push('[features]', 'hooks = true');
  // A freshly appended table always ends the file with a newline, even if the
  // original had no trailing newline.
  return { text: frame(lines, true), changed: true };
}

function frame(lines: string[], trailingNewline: boolean): string {
  const body = lines.join('\n');
  return trailingNewline ? body + '\n' : body;
}

// tableHeader returns the section name for a `[section]` line, or null. `[[x]]`
// array-of-tables lines are not standard tables here and return null.
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

// keyValue parses `key = value` (with optional indent and inline comment). It is
// intentionally shallow: enough to find and rewrite a boolean feature flag.
function keyValue(line: string): KV | null {
  const m = /^(\s*)([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
  if (!m) return null;
  const rhs = m[3]!;
  const hash = rhs.indexOf('#');
  const value = (hash >= 0 ? rhs.slice(0, hash) : rhs).trim();
  const trailing = hash >= 0 ? rhs.slice(hash).trim() : '';
  return { indent: m[1]!, key: m[2]!, value, trailing };
}

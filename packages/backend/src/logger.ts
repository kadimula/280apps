// The platform's structured loggers. On Workers there is no process.stderr, so every
// record is written through console.* (what Workers Logs captures). JSON is what
// production ships and queries; text is for a local loop a human reads.

import type { Logger } from './observe.js';

// newLogger picks the format: json for shipped-and-queried lines, text for local.
export function newLogger(format: 'json' | 'text'): Logger {
  return format === 'json' ? jsonLogger() : textLogger();
}

export function jsonLogger(): Logger {
  const emit = (
    write: (line: string) => void,
    level: string,
    msg: string,
    attrs?: Record<string, unknown>,
  ) => {
    const rec: Record<string, unknown> = { time: new Date().toISOString(), level, msg, ...attrs };
    write(JSON.stringify(rec));
  };
  return {
    info: (m, a) => emit(console.log, 'INFO', m, a),
    warn: (m, a) => emit(console.warn, 'WARN', m, a),
    error: (m, a) => emit(console.error, 'ERROR', m, a),
  };
}

function textLogger(): Logger {
  const emit = (
    write: (line: string) => void,
    level: string,
    msg: string,
    attrs?: Record<string, unknown>,
  ) => {
    const tail = attrs
      ? ' ' +
        Object.entries(attrs)
          .map(([k, v]) => `${k}=${format(v)}`)
          .join(' ')
      : '';
    write(`${new Date().toISOString()} ${level} ${msg}${tail}`);
  };
  return {
    info: (m, a) => emit(console.log, 'INFO', m, a),
    warn: (m, a) => emit(console.warn, 'WARN', m, a),
    error: (m, a) => emit(console.error, 'ERROR', m, a),
  };
}

function format(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  return String(v);
}

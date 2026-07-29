// The platform's structured loggers. On Workers there is no process.stderr;
// console.* is what Workers Logs captures, so every record is written through it
// (info/warn on console.log/console.warn, error on console.error). The JSON form
// is what production ships and queries; the text form stays for a local loop
// where a human reads the lines as they scroll past.

import type { Logger } from './observe.js';

// newLogger picks the format. json is anywhere the lines are shipped to be
// queried (Workers Logs); text is the local loop.
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

import { encode } from '@toon-format/toon';
import { DeployCode } from '@280/contracts';
export const ExitOK = 0;
export const ExitError = 1;
export const ExitUsage = 2;
export interface Streams {
  out(s: string): void;
  err(s: string): void;
}
export const processStreams: Streams = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};
export interface AgentError {
  code: string;
  message: string;
  fix: string;
  retryable: boolean;
  candidates: string[];
}
export class CliError extends Error {
  readonly code: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly candidates: string[];
  constructor(code: string, message: string, fix = '', retryable = false, candidates: string[] = []) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.fix = fix;
    this.retryable = retryable;
    this.candidates = candidates;
  }
}
export function fail(code: string, message: string, fix = ''): CliError {
  return new CliError(code, message, fix);
}
export function asError(e: unknown): AgentError {
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') {
    const a = e as Record<string, unknown>;
    return {
      code: a.code as string,
      message: typeof a.message === 'string' ? a.message : '',
      fix: typeof a.fix === 'string' ? a.fix : '',
      retryable: a.retryable === true,
      candidates: Array.isArray(a.candidates) ? (a.candidates as string[]) : [],
    };
  }
  const raw = e instanceof Error ? e.message : String(e);
  return {
    code: 'unknown',
    message: firstLine(raw),
    fix: '',
    retryable: false,
    candidates: [],
  };
}
function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return (nl >= 0 ? s.slice(0, nl) : s).trim();
}
const CLI_TOO_OLD_FIX = 'run npx two80@latest push';
const UNKNOWN_FIX = 'run the command again; if it persists, check https://280apps.com/status';
export function result(s: Streams, obj: Record<string, unknown>): number {
  s.out(encode(obj) + '\n');
  return ExitOK;
}
export function progress(s: Streams, line: string): void {
  s.err('two80: ' + line + '\n');
}
export function error(s: Streams, e: unknown): number {
  const a = asError(e);
  let fix = a.code === DeployCode.CLITooOld ? CLI_TOO_OLD_FIX : a.fix;
  if (a.code === 'unknown' && fix === '') fix = UNKNOWN_FIX;
  s.out(encode({ error: a.code, message: a.message, fix, retryable: a.retryable }) + '\n');
  return ExitError;
}
function usage(s: Streams, code: string, message: string, help: string): number {
  s.out(encode({ error: code, message, help }) + '\n');
  return ExitUsage;
}
function flagList(cmd: string, validFlags: string[]): string {
  return validFlags.length > 0
    ? `valid flags for \`${cmd}\`: ${validFlags.join(', ')} (--help always allowed)`
    : `\`${cmd}\` takes no flags (--help always allowed)`;
}
const REMOVED_FLAGS: Record<string, string> = {
  json: '--json was removed; stdout is always TOON now, just drop the flag',
};
export function usageError(s: Streams, cmd: string, badFlag: string, validFlags: string[]): number {
  const removed = REMOVED_FLAGS[badFlag.replace(/^--/, '')];
  if (removed !== undefined) {
    return usage(s, 'removed_flag', `flag ${badFlag} was removed`, removed);
  }
  return usage(s, 'unknown_flag', `unknown flag ${badFlag} for \`${cmd}\``, flagList(cmd, validFlags));
}
function argError(s: Streams, cmd: string, badArg: string, validFlags: string[]): number {
  const help =
    validFlags.length > 0
      ? `\`${cmd}\` takes flags, not arguments: ${validFlags.join(', ')} (--help always allowed)`
      : `\`${cmd}\` takes no arguments (--help always allowed)`;
  return usage(s, 'unexpected_argument', `unexpected argument ${badArg} for \`${cmd}\``, help);
}
function valueError(s: Streams, cmd: string, flag: string, validFlags: string[]): number {
  return usage(s, 'missing_value', `flag ${flag} needs a value`, flagList(cmd, validFlags));
}
export function text(s: Streams, body: string): void {
  s.out(body.endsWith('\n') ? body : body + '\n');
}
export interface FlagSpec {
  name: string; // without the leading --
  type: 'string' | 'bool';
}
export interface ParseResult {
  help: boolean;
  values: Record<string, string | boolean>;
  usage?: number;
}
export function parseFlags(s: Streams, cmd: string, args: string[], specs: FlagSpec[]): ParseResult {
  const validNames = specs.map((x) => '--' + x.name);
  const byName = new Map(specs.map((x) => [x.name, x]));
  const values: Record<string, string | boolean> = {};
  for (const spec of specs) values[spec.name] = spec.type === 'bool' ? false : '';
  let i = 0;
  let sawSeparator = false;
  while (i < args.length) {
    const a = args[i]!;
    if (!sawSeparator && (a === '--help' || a === '-h')) return { help: true, values };
    if (!sawSeparator && a === '--') {
      sawSeparator = true;
      i++;
      continue;
    }
    if (!sawSeparator && a.startsWith('--')) {
      let name = a.slice(2);
      let inlineVal: string | undefined;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        inlineVal = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const spec = byName.get(name);
      if (!spec) return { help: false, values, usage: usageError(s, cmd, '--' + name, validNames) };
      if (spec.type === 'bool') {
        values[name] = inlineVal === undefined ? true : inlineVal === 'true' || inlineVal === '1';
      } else if (inlineVal !== undefined) {
        values[name] = inlineVal;
      } else {
        const next = args[i + 1];
        if (next === undefined) return { help: false, values, usage: valueError(s, cmd, '--' + name, validNames) };
        values[name] = next;
        i++;
      }
      i++;
      continue;
    }
    if (!sawSeparator && a.startsWith('-') && a.length > 1) {
      return { help: false, values, usage: usageError(s, cmd, a, validNames) };
    }
    return { help: false, values, usage: argError(s, cmd, a, validNames) };
  }
  return { help: false, values };
}

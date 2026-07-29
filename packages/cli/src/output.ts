// output is the CLI's single AXI layer. Every command result and every error is
// rendered here, so the agent-facing contract lives in one place: TOON on
// stdout, structured errors on stdout (never stderr), stable exit codes, and
// unknown-flag rejection that lists the command's own flags inline.
//
// Spec: cli/internal/output/output.go for exit-code meanings and the error
// shape; plan §3a for the AXI stdout rules that replace Go's stdout bytes.
// The internal logic stays JSON-shaped; TOON is applied only at this boundary
// via the reference encoder (@toon-format/toon), the one extra runtime dep.

import { encode } from '@toon-format/toon';
import { DeployCode } from '@280/contracts';

// Exit codes are part of the agent contract: an agent branches on them without
// parsing text. 0 success (including no-ops), 1 a structured actionable
// failure, 2 misuse (bad flags/args). Everything actionable is code 1 with a fix.
export const ExitOK = 0;
export const ExitError = 1;
export const ExitUsage = 2;

// Streams is the pair of sinks a command writes through. Injected so tests
// capture output with no real stdio. stdout carries data and errors the agent
// consumes; stderr carries progress only.
export interface Streams {
  out(s: string): void;
  err(s: string): void;
}

// processStreams is the production binding to the real process streams.
export const processStreams: Streams = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

// AgentError is the normalized agent-facing error shape.
export interface AgentError {
  code: string;
  message: string;
  fix: string;
  retryable: boolean;
  candidates: string[];
}

// CliError is the throwable the CLI raises for its own failures. The deploy
// seam (and W1's HTTP adapter) throw the same {code,message,fix,retryable}
// shape; asError normalizes both, so callers never care which produced it.
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

// fail wraps a message into the CLI error shape with a runnable fix.
export function fail(code: string, message: string, fix = ''): CliError {
  return new CliError(code, message, fix);
}

// asError duck-types any thrown value into the agent-facing shape. A typed
// deploy/CLI error (anything carrying a string `code`) surfaces unchanged; any
// other error is coerced to an unknown-code failure so nothing escapes the
// contract. The coerced message is clamped to its first line: a raw dependency
// throw (fs, fetch, a bug) can carry a stack or a multi-line dump, and AXI §6
// forbids leaking that noise to the agent. Mirrors Go's deploy.AsError.
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

// CLI_TOO_OLD_FIX is the one fix the CLI rewrites regardless of what the server
// sent: with self-update dropped, the only recovery from a version floor is a
// fresh npx run (plan §6 W2, npm package renamed to two80).
const CLI_TOO_OLD_FIX = 'run npx two80@latest push';

// UNKNOWN_FIX is the fallback fix for an uncoded failure. An unknown error must
// still carry an actionable next step (AXI §6); this mirrors the HTTP adapter's
// default-status fix.
const UNKNOWN_FIX = 'run the command again; if it persists, check https://280apps.com/status';

// result renders a success payload to stdout as TOON, one document per call.
export function result(s: Streams, obj: Record<string, unknown>): number {
  s.out(encode(obj) + '\n');
  return ExitOK;
}

// progress writes one human-facing progress line to stderr. Never data, never
// an error: an agent reads only stdout, so progress must not land there.
export function progress(s: Streams, line: string): void {
  s.err('280: ' + line + '\n');
}

// error renders a structured failure to stdout as TOON and returns exit 1. The
// shape {error, message, fix, retryable} is the agent's real contract; a
// cli_too_old code always carries the npx fix.
export function error(s: Streams, e: unknown): number {
  const a = asError(e);
  let fix = a.code === DeployCode.CLITooOld ? CLI_TOO_OLD_FIX : a.fix;
  if (a.code === 'unknown' && fix === '') fix = UNKNOWN_FIX;
  s.out(encode({ error: a.code, message: a.message, fix, retryable: a.retryable }) + '\n');
  return ExitError;
}

// Usage errors share one shape with runtime errors: `error` is always a machine
// code, never prose, so an agent branching on it never has to guess which kind
// of document it is reading. `help` carries the inline self-correction (AXI §6).
function usage(s: Streams, code: string, message: string, help: string): number {
  s.out(encode({ error: code, message, help }) + '\n');
  return ExitUsage;
}

function flagList(cmd: string, validFlags: string[]): string {
  return validFlags.length > 0
    ? `valid flags for \`${cmd}\`: ${validFlags.join(', ')} (--help always allowed)`
    : `\`${cmd}\` takes no flags (--help always allowed)`;
}

// REMOVED_FLAGS maps flags that once existed (in the Go CLI) to a targeted hint,
// so an agent that learned the old surface self-corrects in one step instead of
// getting the generic valid-flag list (AXI §6).
const REMOVED_FLAGS: Record<string, string> = {
  json: '--json was removed; stdout is always TOON now, just drop the flag',
};

// usageError rejects an unknown flag by name and lists the command's valid
// flags inline, so the agent self-corrects in one turn without a follow-up
// --help call (AXI §6). A removed flag gets its targeted hint instead. Exit 2.
export function usageError(s: Streams, cmd: string, badFlag: string, validFlags: string[]): number {
  const removed = REMOVED_FLAGS[badFlag.replace(/^--/, '')];
  if (removed !== undefined) {
    return usage(s, 'removed_flag', `flag ${badFlag} was removed`, removed);
  }
  return usage(s, 'unknown_flag', `unknown flag ${badFlag} for \`${cmd}\``, flagList(cmd, validFlags));
}

// argError rejects an unexpected positional argument, same exit code as an
// unknown flag: the command took something it cannot act on.
export function argError(s: Streams, cmd: string, badArg: string, validFlags: string[]): number {
  const help =
    validFlags.length > 0
      ? `\`${cmd}\` takes flags, not arguments: ${validFlags.join(', ')} (--help always allowed)`
      : `\`${cmd}\` takes no arguments (--help always allowed)`;
  return usage(s, 'unexpected_argument', `unexpected argument ${badArg} for \`${cmd}\``, help);
}

// valueError rejects a string flag given without a value, same exit code as an
// unknown flag: the invocation cannot be acted on as written.
export function valueError(s: Streams, cmd: string, flag: string, validFlags: string[]): number {
  return usage(s, 'missing_value', `flag ${flag} needs a value`, flagList(cmd, validFlags));
}

// text writes a raw reference block (help output) to stdout verbatim. Help is
// the one documentation surface that is prose, not data (AXI §10).
export function text(s: Streams, body: string): void {
  s.out(body.endsWith('\n') ? body : body + '\n');
}

// FlagSpec declares one flag a command accepts.
export interface FlagSpec {
  name: string; // without the leading --
  type: 'string' | 'bool';
}

// ParseResult is the outcome of parseFlags. Exactly one of these matters to the
// caller: usage set (a usage error was already rendered; return it), help true
// (print the command's --help and exit 0), or neither (use values).
export interface ParseResult {
  help: boolean;
  values: Record<string, string | boolean>;
  usage?: number;
}

// parseFlags parses args against a command's declared flags and enforces the
// AXI guarantee that an unknown flag or unexpected argument is rejected by name
// with the valid flags listed inline (never silently dropped). `--help`/`-h` is
// always allowed. Supports `--flag value`, `--flag=value`, and bare bool flags.
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
    // A bare token (or anything after `--`): these commands take no positionals.
    return { help: false, values, usage: argError(s, cmd, a, validNames) };
  }
  return { help: false, values };
}

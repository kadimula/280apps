import { describe, expect, it } from 'vitest';
import * as output from '../src/output.js';
import { capture } from './helpers.js';

describe('result rendering (TOON on stdout)', () => {
  it('encodes a success payload as TOON and exits 0', () => {
    const c = capture();
    const code = output.result(c.streams, { url: 'https://x-y.280apps.run', slug: 'demo' });
    expect(code).toBe(output.ExitOK);
    expect(c.out()).toBe('url: "https://x-y.280apps.run"\nslug: demo\n');
    expect(c.err()).toBe('');
  });

  it('renders a help[n] list inline (reversible TOON array)', () => {
    const c = capture();
    output.result(c.streams, { name: 'demo', help: ['Run `two80 push` to deploy'] });
    expect(c.out()).toBe('name: demo\nhelp[1]: Run `two80 push` to deploy\n');
  });
});

describe('progress goes to stderr only', () => {
  it('never writes progress to stdout', () => {
    const c = capture();
    output.progress(c.streams, 'uploaded 1/2');
    expect(c.out()).toBe('');
    expect(c.err()).toBe('two80: uploaded 1/2\n');
  });
});

describe('error rendering (TOON on stdout, exit 1)', () => {
  it('renders {error,message,fix,retryable} on stdout', () => {
    const c = capture();
    const code = output.error(c.streams, output.fail('unauthorized', 'not logged in to 280', 'run two80 login'));
    expect(code).toBe(output.ExitError);
    expect(c.out()).toBe('error: unauthorized\nmessage: not logged in to 280\nfix: run two80 login\nretryable: false\n');
    expect(c.err()).toBe('');
  });

  it('overrides the fix for cli_too_old to the npx line regardless of server text', () => {
    const c = capture();
    output.error(c.streams, { code: 'cli_too_old', message: 'this CLI is too old', fix: 'update your binary' });
    expect(c.out()).toContain('error: cli_too_old');
    expect(c.out()).toContain('fix: run npx two80@latest push');
  });

  it('coerces an unknown thrown value to code unknown with a default fix', () => {
    const c = capture();
    output.error(c.streams, new Error('boom'));
    const t = c.out();
    expect(t).toContain('error: unknown');
    expect(t).toContain('message: boom');
    expect(t).toContain('run the command again');
    expect(t).toContain('280apps.com/status');
  });

  it('clamps a raw multi-line dependency message to its first line', () => {
    const c = capture();
    output.error(c.streams, new Error('ECONNREFUSED 127.0.0.1:443\n    at TCPConnectWrap.afterConnect\n    at process'));
    const t = c.out();
    expect(t).toContain('ECONNREFUSED 127.0.0.1:443');
    expect(t).not.toContain('afterConnect');
  });

  it('preserves a retryable flag', () => {
    const c = capture();
    output.error(c.streams, { code: 'unavailable', message: 'x', fix: 'y', retryable: true });
    expect(c.out()).toContain('retryable: true');
  });
});

describe('parseFlags (AXI unknown-flag rejection)', () => {
  const pushSpecs: output.FlagSpec[] = [
    { name: 'name', type: 'string' },
    { name: 'framework', type: 'string' },
    { name: 'new', type: 'bool' },
  ];

  it('parses --flag value, --flag=value, and bare bools', () => {
    const c = capture();
    const p = output.parseFlags(c.streams, 'push', ['--name', 'x', '--framework=next', '--new'], pushSpecs);
    expect(p.usage).toBeUndefined();
    expect(p.values).toEqual({ name: 'x', framework: 'next', new: true });
  });

  it('defaults unspecified flags to zero values', () => {
    const c = capture();
    const p = output.parseFlags(c.streams, 'push', [], pushSpecs);
    expect(p.values).toEqual({ name: '', framework: '', new: false });
  });

  it('rejects an unknown flag by name and lists valid flags inline (exit 2)', () => {
    const c = capture();
    const p = output.parseFlags(c.streams, 'push', ['--stat'], pushSpecs);
    expect(p.usage).toBe(output.ExitUsage);
    expect(c.out()).toBe(
      'error: unknown_flag\nmessage: unknown flag --stat for `push`\nhelp: "valid flags for `push`: --name, --framework, --new (--help always allowed)"\n',
    );
  });

  it('a removed flag gets a targeted hint, not the generic list (exit 2)', () => {
    const c = capture();
    const p = output.parseFlags(c.streams, 'push', ['--json'], pushSpecs);
    expect(p.usage).toBe(output.ExitUsage);
    const t = c.out();
    expect(t).toContain('error: removed_flag');
    expect(t).toContain('--json was removed');
    expect(t).not.toContain('valid flags for');
  });

  it('rejects an unexpected positional argument (exit 2)', () => {
    const c = capture();
    const p = output.parseFlags(c.streams, 'whoami', ['extra'], []);
    expect(p.usage).toBe(output.ExitUsage);
    expect(c.out()).toContain('error: unexpected_argument');
    expect(c.out()).toContain('unexpected argument extra for `whoami`');
    expect(c.out()).toContain('`whoami` takes no arguments');
  });

  it('rejects a string flag given without a value (exit 2)', () => {
    const c = capture();
    const p = output.parseFlags(c.streams, 'push', ['--name'], pushSpecs);
    expect(p.usage).toBe(output.ExitUsage);
    expect(c.out()).toContain('error: missing_value');
    expect(c.out()).toContain('flag --name needs a value');
  });

  it('always allows --help and -h', () => {
    const c1 = capture();
    expect(output.parseFlags(c1.streams, 'push', ['--help'], pushSpecs).help).toBe(true);
    const c2 = capture();
    expect(output.parseFlags(c2.streams, 'push', ['-h'], pushSpecs).help).toBe(true);
    expect(c1.out()).toBe('');
  });

  it('reports no-flag commands cleanly', () => {
    const c = capture();
    output.parseFlags(c.streams, 'whoami', ['--verbose'], []);
    expect(c.out()).toContain('`whoami` takes no flags (--help always allowed)');
  });
});

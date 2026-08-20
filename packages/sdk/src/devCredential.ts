// Local development only. In production the gateway signs an identity header and this
// module is never consulted (a token is always present). Under `next dev` there is no
// gateway, so the SDK authenticates the developer with their `two80 login` machine
// token and the app id from `.280/config.json` — the same files the CLI already wrote.
// Everything here degrades to null on any error so a missing setup just yields the
// backend's normal unauthenticated response rather than a crash.

export interface DevCredential {
  token: string;
  appId: string;
  origin: string;
}

export async function loadDevCredential(): Promise<DevCredential | null> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  let token = str(env.TWO80_TOKEN);
  let origin = str(env.TWO80_API);
  let appId = str(env.TWO80_APP);

  if (token === '' || origin === '') {
    const home = await osHomedir();
    const creds = home === '' ? null : await readJson(join(home, '.280', 'credentials'));
    if (creds !== null) {
      if (token === '') token = str(creds.token);
      if (origin === '') origin = str(creds.api);
    }
  }
  if (appId === '') {
    const cwd = procCwd();
    const cfg = cwd === '' ? null : await readJson(join(cwd, '.280', 'config.json'));
    if (cfg !== null) appId = str(cfg.appId);
  }

  if (token === '' || appId === '' || origin === '') return null;
  return { token, appId, origin };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function osHomedir(): Promise<string> {
  try {
    const os = await import('node:os');
    return os.homedir();
  } catch {
    return '';
  }
}

function procCwd(): string {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  try {
    return typeof proc?.cwd === 'function' ? proc.cwd() : '';
  } catch {
    return '';
  }
}

function join(...parts: string[]): string {
  return parts.join('/');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

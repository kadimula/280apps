import { Hono } from 'hono';
import type { Context } from 'hono';
import { DeployCode, requiredConfigNames } from '@280/contracts';
import type { HonoEnv } from '../../observe.js';
import {
  SMALL_LIMIT,
  asObject,
  badRequest,
  nowSecs,
  ownedApp,
  readJson,
  route,
  unavailable,
} from '../kernel.js';

export function secretsRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.get('/internal/apps/:app/secrets', route(handleSecretsList));
  app.post('/internal/apps/:app/secrets', route(handleSecretPut));
  app.post('/internal/apps/:app/secrets/reveal', route(handleSecretReveal));
  app.post('/internal/apps/:app/secrets/delete', route(handleSecretDelete));
  return app;
}

async function handleSecretsList(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const [{ secrets, config }, stored] = await Promise.all([
    declaredVariables(c, app.id),
    c.get('deps').platform.store.appSecrets(app.id),
  ]).catch(() => {
    throw unavailable('could not read the app secrets');
  });
  const byName = new Map(stored.map((s) => [s.name, s]));
  const row = (name: string, kind: 'secret' | 'config') => {
    const s = byName.get(name);
    return s ? { name, kind, configured: true, setBy: s.setBy, setAt: s.setAt } : { name, kind, configured: false };
  };
  return c.json({
    secrets: [
      ...secrets.map((name) => row(name, 'secret')),
      ...config.map((name) => row(name, 'config')),
    ],
  });
}

// A parked deploy must always be configurable, and an expired park must be
// configurable before the re-push, so gather from the live policy, every open
// deploy, and the newest deploy even when it failed.
async function declaredVariables(
  c: Context<HonoEnv>,
  appId: string,
): Promise<{ secrets: string[]; config: string[] }> {
  const store = c.get('deps').platform.store;
  const [policy, latest, open] = await Promise.all([
    store.appPolicy(appId),
    store.latestDeploy(appId).catch(() => null),
    store.openDeploys(appId).catch(() => []),
  ]);
  const secrets = new Set(policy?.secrets ?? []);
  const config = new Set(requiredConfigNames(policy?.config ?? []));
  for (const dep of [latest, ...open]) {
    for (const name of dep?.manifest.secrets ?? []) secrets.add(name);
    for (const name of requiredConfigNames(dep?.manifest.config ?? [])) config.add(name);
  }
  return { secrets: [...secrets], config: [...config] };
}

async function handleSecretPut(c: Context<HonoEnv>): Promise<Response> {
  const { user, app } = await ownedApp(c);
  const req = await readJson(c, SMALL_LIMIT, secretPutSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the secret',
    appendReason: false,
  });
  if (req.name === '') throw badRequest('name the secret to configure');
  if (req.value === '') throw badRequest('secret values cannot be empty');

  const cipher = c.get('deps').secretCipher;
  if (cipher === undefined) throw unavailable('secret storage is not configured');
  const { secrets, config } = await declaredVariables(c, app.id).catch(() => {
    throw unavailable('could not read the app secrets');
  });
  const isConfig = config.includes(req.name);
  if (!isConfig && !secrets.includes(req.name)) {
    throw badRequest(`"${req.name}" is not declared in this app's 280.json`);
  }

  try {
    await c.get('deps').platform.store.putAppSecret({
      appId: app.id,
      name: req.name,
      envelope: await cipher.protect(app.id, req.name, req.value),
      setBy: user.email,
      setAt: nowSecs(),
      kind: isConfig ? 'config' : 'secret',
    });
  } catch {
    throw unavailable('could not save the secret');
  }
  await c.get('deps').platform.resumeWaiting(app).catch(() => {
    throw unavailable('could not resume the waiting deploy');
  });
  return c.body(null, 204);
}

async function handleSecretReveal(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const req = await readJson(c, SMALL_LIMIT, secretNameSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the secret name',
    appendReason: false,
  });
  const cipher = c.get('deps').secretCipher;
  if (cipher === undefined) throw unavailable('secret storage is not configured');
  const stored = await c.get('deps').platform.store.appSecrets(app.id).catch(() => {
    throw unavailable('could not read the app secrets');
  });
  const secret = stored.find((candidate) => candidate.name === req.name);
  if (!secret) throw badRequest('this variable has no value');
  try {
    c.header('Cache-Control', 'no-store');
    return c.json({ value: await cipher.reveal(app.id, secret.name, secret.envelope) });
  } catch {
    throw unavailable('could not reveal the variable');
  }
}

async function handleSecretDelete(c: Context<HonoEnv>): Promise<Response> {
  const { user, app } = await ownedApp(c);
  const req = await readJson(c, SMALL_LIMIT, secretNameSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the secret name',
    appendReason: false,
  });
  await c.get('deps').platform.store.deleteAppSecret(app.id, req.name, user.email).catch(() => {
    throw unavailable('could not delete the variable');
  });
  return c.body(null, 204);
}

const secretNameSchema = {
  parse(u: unknown): { name: string } {
    const object = asObject(u);
    if (typeof object.name !== 'string' || object.name === '') {
      throw new Error('name must be a non-empty string');
    }
    return { name: object.name };
  },
};

const secretPutSchema = {
  parse(u: unknown): { name: string; value: string } {
    const object = asObject(u);
    if (typeof object.name !== 'string' || typeof object.value !== 'string') {
      throw new Error('expected string name and value');
    }
    return { name: object.name, value: object.value };
  },
};

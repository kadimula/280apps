import { Hono } from 'hono';
import type { Context } from 'hono';
import { DeployCode, DeployErr, deleteAppRequestSchema } from '@280/contracts';
import type { HonoEnv } from '../../observe.js';
import { encodeDeleteResult, encodeStatus } from '../encode.js';
import { SMALL_LIMIT, readJson, route, sessionUser, unavailable } from '../kernel.js';

const DASHBOARD_CONFIRM = 'delete';

export function appsRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.get('/internal/apps', route(handleApps));
  app.get('/internal/apps/:app/status', route(handleInternalStatus));
  app.post('/internal/apps/:app/delete', route(handleInternalDelete));
  return app;
}

async function handleApps(c: Context<HonoEnv>): Promise<Response> {
  const user = await sessionUser(c);

  let apps;
  try {
    apps = await c.get('deps').platform.store.appsByUser(user.id);
  } catch {
    throw unavailable('could not list apps');
  }
  return c.json({
    apps: apps.map((a) => ({
      id: a.id,
      slug: a.slug,
      url: a.url,
      live: a.activeDeploy !== '',
      createdAt: a.createdAt,
      lastDeployAt: a.lastDeployAt,
    })),
  });
}

async function handleInternalStatus(c: Context<HonoEnv>): Promise<Response> {
  const user = await sessionUser(c);
  const st = await c.get('deps').platform.for(user.id).appStatus(c.req.param('app') ?? '');
  return c.json(encodeStatus(st));
}

async function handleInternalDelete(c: Context<HonoEnv>): Promise<Response> {
  const user = await sessionUser(c);

  const req = await readJson(c, SMALL_LIMIT, deleteAppRequestSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the delete request',
    appendReason: false,
  });

  const svc = c.get('deps').platform.for(user.id);

  // The dry run does the looking up: it fails closed on an app this account does
  // not own, and it is where the slug comes from.
  const target = await svc.delete({ appId: c.req.param('app') ?? '', confirm: '' });
  if (req.confirm.trim().toLowerCase() !== DASHBOARD_CONFIRM) {
    throw new DeployErr({
      code: DeployCode.ConfirmationRequired,
      message: 'deleting ' + target.app.slug + ' destroys the app, its URL, and its data',
      fix: 'type ' + DASHBOARD_CONFIRM + ' to confirm',
    });
  }

  const res = await svc.delete({ appId: target.app.id, confirm: target.app.slug });
  return c.json(encodeDeleteResult(res));
}

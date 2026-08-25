import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { AuthCode, DeployCode, DeployErr, approveRequestSchema, tokenRequestSchema } from '@280/contracts';
import { hashToken } from '../../crypto.js';
import type { HonoEnv } from '../../observe.js';
import { DeviceStatus } from '../../seams.js';
import {
  SMALL_LIMIT,
  nowSecs,
  randomSecret,
  readBodyText,
  readJson,
  route,
  sessionUser,
  unavailable,
} from '../kernel.js';

const DEVICE_CODE_TTL_SECS = 15 * 60;
const DEVICE_POLL_SECS = 5;

// Omits characters that are misread when a human copies a code off one screen.
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';

export function deviceRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.post('/v1/device/code', route(handleDeviceCode));
  app.post('/v1/device/token', route(handleDeviceToken));
  app.post('/internal/device/approve', route(handleDeviceApprove));
  return app;
}

async function handleDeviceCode(c: Context<HonoEnv>): Promise<Response> {
  const deviceCode = randomSecret(32);
  const userCode = randomUserCode();
  const expiresAt = nowSecs() + DEVICE_CODE_TTL_SECS;
  try {
    await c.get('deps').platform.store.createDeviceCode({
      deviceHash: hashToken(deviceCode),
      userCode,
      userId: '',
      status: DeviceStatus.Pending,
      expiresAt,
    });
  } catch {
    throw unavailable('could not start login');
  }
  return c.json({
    deviceCode,
    userCode: displayUserCode(userCode),
    verificationUri: c.get('deps').verificationUri,
    expiresIn: DEVICE_CODE_TTL_SECS,
    interval: DEVICE_POLL_SECS,
  });
}

async function handleDeviceToken(c: Context<HonoEnv>): Promise<Response> {
  let deviceCode = '';
  try {
    const raw = await readBodyText(c, SMALL_LIMIT);
    const req = tokenRequestSchema.parse(JSON.parse(raw));
    deviceCode = req.deviceCode;
  } catch {
    deviceCode = '';
  }
  if (deviceCode === '') {
    throw new DeployErr({
      code: AuthCode.ExpiredToken,
      message: 'that login request is not valid',
      fix: 'run two80 login',
    });
  }

  let dc;
  try {
    dc = await c.get('deps').platform.store.deviceCodeByHash(hashToken(deviceCode));
  } catch {
    throw unavailable('login lookup failed');
  }
  // Unknown, expired, and already-claimed get one answer on purpose: telling a
  // caller which it hit is free reconnaissance on a guessed code.
  if (dc === null || dc.status === DeviceStatus.Claimed || nowSecs() >= dc.expiresAt) {
    throw new DeployErr({
      code: AuthCode.ExpiredToken,
      message: 'that login request expired',
      fix: 'run two80 login',
    });
  }
  if (dc.status === DeviceStatus.Pending) {
    throw new DeployErr({
      code: AuthCode.AuthorizationPending,
      message: 'waiting for the user to finish signing in',
      fix: 'ask your user to open the login link, then run two80 login again',
    });
  }

  // Whoever wins the claim is the only caller that may mint a token for this code,
  // so a duplicated poll cannot produce two credentials.
  let won: boolean;
  try {
    won = await c.get('deps').platform.store.claimDeviceCode(dc.deviceHash);
  } catch {
    throw unavailable('could not complete login');
  }
  if (!won) {
    throw new DeployErr({
      code: AuthCode.ExpiredToken,
      message: 'that login request expired',
      fix: 'run two80 login',
    });
  }

  const token = randomSecret(32);
  try {
    await c.get('deps').platform.store.addToken(dc.userId, hashToken(token));
  } catch {
    throw unavailable('could not complete login');
  }
  return c.json({ token });
}

async function handleDeviceApprove(c: Context<HonoEnv>): Promise<Response> {
  const user = await sessionUser(c);

  const req = await readJson(c, SMALL_LIMIT, approveRequestSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the approval',
    appendReason: false,
  });

  // The principal is the signed-in user, not a body field: a browser cannot approve
  // a login for anyone but itself.
  let ok: boolean;
  try {
    ok = await c.get('deps').platform.store.approveDeviceCode(normalizeUserCode(req.userCode), user.id, nowSecs());
  } catch {
    throw unavailable('could not record the approval');
  }
  if (!ok) {
    throw new DeployErr({
      code: AuthCode.ExpiredToken,
      message: 'that code is not waiting for approval',
      fix: 'ask your agent to run two80 login again',
    });
  }
  return c.body(null, 204);
}

function randomUserCode(): string {
  const b = randomBytes(8);
  let out = '';
  for (const v of b) out += USER_CODE_ALPHABET[v % USER_CODE_ALPHABET.length];
  return out;
}

function displayUserCode(code: string): string {
  if (code.length !== 8) return code;
  return code.slice(0, 4) + '-' + code.slice(4);
}

function normalizeUserCode(s: string): string {
  return s.trim().toUpperCase().replaceAll('-', '');
}

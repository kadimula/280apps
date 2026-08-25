// Wire encoders mirror Go's omitempty semantics.

import type {
  App as PublicApp,
  DeleteResult,
  DeployError,
  DeployStatus,
  LogRecord,
  LogsResult,
  SyncResult,
} from '@280/contracts';
import type { User } from '../seams.js';

export function encodeError(e: DeployError): Record<string, unknown> {
  const out: Record<string, unknown> = { code: e.code, message: e.message };
  if (e.fix) out.fix = e.fix;
  if (e.retryable) out.retryable = e.retryable;
  if (e.candidates && e.candidates.length > 0) out.candidates = e.candidates;
  return out;
}

export function encodeApp(a: PublicApp): Record<string, unknown> {
  return { id: a.id, slug: a.slug, url: a.url };
}

export function encodeSyncResult(r: SyncResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    app: encodeApp(r.app),
    resolution: r.resolution,
    deployId: r.deployId,
    state: r.state,
    // Go's nil Missing slice renders as null (never []); the client normalizes it back.
    missing: r.missing && r.missing.length > 0 ? r.missing : null,
  };
  if (r.failure) out.failure = encodeError(r.failure as DeployError);
  return out;
}

export function encodeStatus(s: DeployStatus): Record<string, unknown> {
  const out: Record<string, unknown> = { state: s.state };
  if (s.url) out.url = s.url;
  if (s.notice) out.notice = s.notice;
  if (s.secretNotice) out.secretNotice = s.secretNotice;
  if (s.integrationNotice) out.integrationNotice = s.integrationNotice;
  if (s.failure) out.failure = encodeError(s.failure as DeployError);
  return out;
}

export function encodeDeleteResult(r: DeleteResult): Record<string, unknown> {
  return { app: encodeApp(r.app), deleted: r.deleted };
}

export function encodeLogs(r: LogsResult): Record<string, unknown> {
  return { records: r.records.map(encodeLogRecord) };
}

function encodeLogRecord(l: LogRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { time: l.time, level: l.level, message: l.message };
  if (l.path) out.path = l.path;
  if (l.digest) out.digest = l.digest;
  if (l.stack) out.stack = l.stack;
  return out;
}

export function encodeUser(u: User): Record<string, unknown> {
  return { id: u.id, email: u.email, name: u.name, image: u.image };
}

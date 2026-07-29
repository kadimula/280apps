// HTTP fixture replay (plan §4.2). The Go side records real request/response
// pairs from its conformance-over-HTTP run (platform/httpfixtures_test.go) into
// testdata/http-fixtures.json. This replays every recorded request against the
// TS server and byte-compares the JSON after key sort. Where cross-conformance
// proves behavior, this proves the wire bytes are identical: field names,
// omitempty, error {code, message, fix} shapes.
//
// The one thing that legitimately differs between the two servers is a freshly
// minted id: app ids embed 6 random bytes, and deploy ids and url tokens derive
// from them. So the replay (a) threads the TS server's real ids into the paths
// and bodies of later requests in the same case, and (b) normalizes those ids to
// placeholders before comparing. Everything else — digests, slugs, states, error
// strings — must match to the byte.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { Server } from '../src/api.js';
import type { HonoEnv } from '../src/observe.js';
import { newPlatform, testDeps, type Harness } from './helpers/harness.js';

interface Exchange {
  case: string;
  method: string;
  path: string;
  reqBody?: string;
  reqBlobB64?: string;
  status: number;
  respBody?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'testdata', 'http-fixtures.json');
const exchanges: Exchange[] = JSON.parse(readFileSync(fixturePath, 'utf8'));

// Group exchanges into their cases, preserving recording order within each.
function byCase(all: Exchange[]): Map<string, Exchange[]> {
  const m = new Map<string, Exchange[]>();
  for (const ex of all) {
    const list = m.get(ex.case) ?? [];
    list.push(ex);
    m.set(ex.case, list);
  }
  return m;
}

// canonical stringifies with keys sorted at every level (the "key sort" the plan
// calls for) and arrays sorted too. The Go recorder canonicalizes the same way,
// because the conformance suite's map-built manifests put assets/missing in a
// non-deterministic order that carries no contract; sorting both sides compares
// the part that is actually specified.
function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    const items = v.map(sortValue);
    return items.sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

const APP_ID = /app_[0-9a-f]{12}/g;
const DEPLOY_ID = /dep_[0-9a-f]{16}/g;
const URL_TOKEN = /-[0-9a-z]{10}\.280apps\.run/g;

// normalize masks the values that are allowed to differ between servers because
// they carry per-app randomness. Everything else survives to be compared.
function normalize(s: string): string {
  return s.replace(APP_ID, 'app_XXX').replace(DEPLOY_ID, 'dep_XXX').replace(URL_TOKEN, '-XXX.280apps.run');
}

// collectIds walks a parsed body and returns the app/dep ids it contains, in a
// stable traversal order. Two structurally identical bodies yield ids in the
// same order, which is what lets the replay learn Go-id → TS-id pairs positionally
// without hard-coding which field each id lives in.
function collectIds(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (/^app_[0-9a-f]{12}$/.test(v) || /^dep_[0-9a-f]{16}$/.test(v)) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collectIds(x, out);
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      collectIds((v as Record<string, unknown>)[k], out);
    }
  }
  return out;
}

// applySubst rewrites every recorded (Go) id to the id the TS server actually
// minted, so a path or body that refers back to an earlier app/deploy addresses
// the right one.
function applySubst(s: string, subst: Map<string, string>): string {
  let out = s;
  for (const [from, to] of subst) out = out.split(from).join(to);
  return out;
}

let harness: Harness;
let app: Hono<HonoEnv>;

beforeAll(async () => {
  harness = await newPlatform();
  app = new Server({ buildDeps: () => testDeps(harness, { openSignup: true }) }).handler();
});

afterAll(async () => {
  await harness.cleanup();
});

describe('http fixture replay (Go recording → TS server)', () => {
  for (const [caseName, list] of byCase(exchanges)) {
    it(caseName, async () => {
      // A token nothing else uses, so each case gets its own account and cannot
      // collide with another case's apps on the shared server.
      const auth = { Authorization: `Bearer fixture-${caseName}` };
      const subst = new Map<string, string>();

      for (const ex of list) {
        const path = applySubst(ex.path, subst);
        const init: RequestInit = { method: ex.method, headers: { ...auth } };

        if (ex.reqBlobB64 !== undefined) {
          (init.headers as Record<string, string>)['Content-Type'] = 'application/octet-stream';
          init.body = Buffer.from(ex.reqBlobB64, 'base64');
        } else if (ex.reqBody !== undefined) {
          (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
          init.body = applySubst(ex.reqBody, subst);
        }

        const res = await app.request(path, init);
        const actualText = await res.text();

        expect(res.status, `${caseName} ${ex.method} ${ex.path} status`).toBe(ex.status);

        const recorded = ex.respBody ?? '';
        if (recorded.trim() === '') {
          expect(actualText.trim(), `${caseName} ${ex.method} ${ex.path} empty body`).toBe('');
          continue;
        }

        // Learn the id mapping from the raw (un-normalized) bodies before masking,
        // so later requests in this case can address the TS server's ids.
        const recordedObj = JSON.parse(recorded);
        const actualObj = JSON.parse(actualText);
        const recIds = collectIds(recordedObj);
        const actIds = collectIds(actualObj);
        for (let i = 0; i < Math.min(recIds.length, actIds.length); i++) {
          if (recIds[i] !== actIds[i]) subst.set(recIds[i], actIds[i]);
        }

        // Byte-compare after key sort and id masking.
        const want = canonical(JSON.parse(normalize(recorded)));
        const got = canonical(JSON.parse(normalize(actualText)));
        expect(got, `${caseName} ${ex.method} ${ex.path} body`).toBe(want);
      }
    });
  }
});

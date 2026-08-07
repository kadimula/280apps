// The docs endpoints are unauthenticated GETs the frontend proxies at their
// public URLs. They carry no per-app randomness, so unlike the deploy routes
// they can be asserted against their exact source rendering.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Server } from '../src/api.js';
import {
  docsCapabilities,
  SUPPORT_MATRIX,
  CAPABILITY_REQUIREMENT,
} from '../src/docs.js';
import { newPlatform, testDeps } from './helpers/harness.js';

const SETUP_MARKDOWN = readFileSync(new URL('../src/docs/setup.md', import.meta.url), 'utf8');
const PLATFORM_SUPPORT_MARKDOWN = readFileSync(
  new URL('../src/docs/platform-support.md', import.meta.url),
  'utf8',
);

describe('docs endpoints', () => {
  async function server() {
    const harness = await newPlatform();
    const app = new Server({ buildDeps: () => testDeps(harness) }).handler();
    return { app, cleanup: harness.cleanup };
  }

  it('serves setup.md as markdown', async () => {
    const { app, cleanup } = await server();
    try {
      const res = await app.request('/v1/docs/setup.md');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(await res.text()).toBe(SETUP_MARKDOWN);
    } finally {
      await cleanup();
    }
  });

  it('serves the support matrix as markdown', async () => {
    const { app, cleanup } = await server();
    try {
      const res = await app.request('/v1/docs/platform-support.md');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
      const body = await res.text();
      expect(body).toBe(PLATFORM_SUPPORT_MARKDOWN);
      // The matrix is a real table an agent parses, not an empty stub.
      expect(body).toContain('| Stack | Feature | Supported | Notes |');
      expect(body).toContain(CAPABILITY_REQUIREMENT);
    } finally {
      await cleanup();
    }
  });

  it('serves capabilities as JSON for the docs page', async () => {
    const { app, cleanup } = await server();
    try {
      const res = await app.request('/v1/docs/capabilities');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = (await res.json()) as ReturnType<typeof docsCapabilities>;
      expect(body.requirement).toBe(CAPABILITY_REQUIREMENT);
      expect(body.matrix).toEqual(SUPPORT_MATRIX);
    } finally {
      await cleanup();
    }
  });

  it('does not require auth', async () => {
    const { app, cleanup } = await server();
    try {
      // no Authorization header at all; deploy routes would 401 here
      const res = await app.request('/v1/docs/setup.md');
      expect(res.status).toBe(200);
    } finally {
      await cleanup();
    }
  });
});

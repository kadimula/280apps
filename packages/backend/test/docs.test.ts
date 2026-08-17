// The docs endpoints are unauthenticated GETs the frontend proxies at their
// public URLs. They carry no per-app randomness, so unlike the deploy routes
// they can be asserted against their exact source rendering.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capabilityNames, capabilityOperations } from '@280/contracts';
import { Server } from '../src/api.js';
import {
  docsCapabilities,
  capabilitiesMarkdown,
  capabilityDocs,
  SDK_CAPABILITIES,
  SUPPORT_MATRIX,
  CAPABILITY_REQUIREMENT,
} from '../src/docs.js';
import { newPlatform, testDeps } from './helpers/harness.js';

const SETUP_MARKDOWN = readFileSync(new URL('../src/docs/setup.md', import.meta.url), 'utf8');

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

  it('serves capabilities.md as markdown', async () => {
    const { app, cleanup } = await server();
    try {
      const res = await app.request('/v1/docs/capabilities.md');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
      expect(await res.text()).toBe(capabilitiesMarkdown());
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

// Drift guard: every capability doc surface is generated from the @280/contracts
// catalog. These assert both directions — the catalog's capabilities/operations all
// appear, and nothing outside the catalog does — so hand-editing docs fails CI.
describe('capability docs track the catalog', () => {
  it('capabilityDocs mirrors the catalog exactly', () => {
    expect(capabilityDocs()).toEqual(
      capabilityNames().map((slug) => ({
        slug,
        title: expect.any(String),
        operations: [...capabilityOperations(slug)],
      })),
    );
  });

  it('the styled matrix SDK group lists exactly the catalog capabilities and operations', () => {
    const notes = SDK_CAPABILITIES.features.map((f) => f.note);
    expect(SDK_CAPABILITIES.features).toHaveLength(capabilityNames().length);
    for (const slug of capabilityNames()) {
      const ops = [...capabilityOperations(slug)];
      expect(notes).toContain(`Operations: ${ops.join(', ')}`);
    }
  });

  it('capabilities.md contains every catalog slug and operation', () => {
    const md = capabilitiesMarkdown();
    for (const slug of capabilityNames()) {
      expect(md).toContain(`\`${slug}\``);
      for (const op of capabilityOperations(slug)) {
        expect(md).toContain(`\`${op}\``);
      }
    }
  });

  it('capabilities.md is self-sufficient on request scoping (no unlinked README deferral)', () => {
    const md = capabilitiesMarkdown();
    expect(md).toContain('### Request scoping');
    expect(md).toContain('identity(');
    expect(md).toContain('await headers()');
    expect(md).not.toContain('README');
  });

  it('capabilities.md table rows map one-to-one onto the catalog', () => {
    const md = capabilitiesMarkdown();
    const rows = md
      .split('\n')
      .filter((line) => /^\| .+ \| `[a-z-]+` \|/.test(line));
    const parsed = rows.map((row) => {
      const cells = row.split('|').map((c) => c.trim());
      const slug = cells[2].replace(/`/g, '');
      const operations = cells[3]
        .split(',')
        .map((c) => c.trim().replace(/`/g, ''))
        .filter(Boolean);
      return { slug, operations };
    });
    expect(parsed).toEqual(
      capabilityNames().map((slug) => ({
        slug,
        operations: [...capabilityOperations(slug)],
      })),
    );
  });
});

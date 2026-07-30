import { describe, expect, it } from 'vitest';
import { discoverNextRoutes } from './nextroutes.js';

describe('discoverNextRoutes (App Router)', () => {
  it('maps page.tsx files to their routes and the root to /', () => {
    expect(
      discoverNextRoutes(['app/page.tsx', 'app/admin/page.tsx', 'app/settings/page.jsx']),
    ).toEqual(['/', '/admin', '/settings']);
  });

  it('maps route.ts handlers to API paths', () => {
    expect(discoverNextRoutes(['app/api/approve/route.ts'])).toEqual(['/api/approve']);
  });

  it('collapses dynamic and catch-all segments to *', () => {
    expect(discoverNextRoutes(['app/admin/[id]/page.tsx', 'app/blog/[...slug]/page.tsx'])).toEqual([
      '/admin/*',
      '/blog/*',
    ]);
  });

  it('drops route groups', () => {
    expect(discoverNextRoutes(['app/(marketing)/about/page.tsx'])).toEqual(['/about']);
  });

  it('supports the src/ prefix', () => {
    expect(discoverNextRoutes(['src/app/admin/page.tsx'])).toEqual(['/admin']);
  });

  it('ignores non-route files', () => {
    expect(discoverNextRoutes(['app/lib/util.ts', 'app/components/Nav.tsx'])).toEqual([]);
  });
});

describe('discoverNextRoutes (Pages Router)', () => {
  it('maps index and nested pages, and api routes', () => {
    expect(discoverNextRoutes(['pages/index.tsx', 'pages/dashboard.tsx', 'pages/api/x.ts'])).toEqual([
      '/',
      '/api/x',
      '/dashboard',
    ]);
  });

  it('collapses dynamic pages and skips framework files', () => {
    expect(
      discoverNextRoutes(['pages/blog/[slug].tsx', 'pages/_app.tsx', 'pages/_document.tsx']),
    ).toEqual(['/blog/*']);
  });
});

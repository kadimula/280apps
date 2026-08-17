const EXT = '(?:jsx?|tsx?)';
const APP_FILE = new RegExp(`^(?:src/)?app/(?:(.*)/)?(page|route)\\.${EXT}$`);
const PAGES_FILE = new RegExp(`^(?:src/)?pages/(.+)\\.${EXT}$`);
export function discoverNextRoutes(paths: string[]): string[] {
  const routes = new Set<string>();
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/');
    const a = appRoute(p);
    if (a !== null) routes.add(a);
    const g = pagesRoute(p);
    if (g !== null) routes.add(g);
  }
  return [...routes].sort();
}
function appRoute(p: string): string | null {
  const m = APP_FILE.exec(p);
  if (m === null) return null;
  return toRoute((m[1] ?? '').split('/'));
}
function pagesRoute(p: string): string | null {
  const m = PAGES_FILE.exec(p);
  if (m === null) return null;
  const segs = m[1]!.split('/');
  const base = segs[segs.length - 1] ?? '';
  if (base.startsWith('_')) return null; // _app, _document, _error are not routes
  if (segs[segs.length - 1] === 'index') segs.pop();
  return toRoute(segs);
}
function toRoute(segments: string[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg === '') continue;
    if (/^\(.*\)$/.test(seg)) continue;
    if (/^\[\[?\.{3}.+\]?\]$/.test(seg) || /^\[.+\]$/.test(seg)) {
      parts.push('*');
      continue;
    }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

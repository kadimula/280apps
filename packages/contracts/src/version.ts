// Compares 280 CLI release versions. Both ends need this and must never
// disagree. Spec: contracts/version/version.go. Go is normative.
//
// A version is a release tag with an optional leading v: 1.2.3, v1.2.3, or
// v1.2.3-rc1. Anything else is not a version at all, and valid() reports so.

type Parts = {
  major: number;
  minor: number;
  patch: number;
  pre: string; // prerelease, "" when none
};

// valid reports whether s is a version this package can order.
export function valid(s: string): boolean {
  return parse(s) !== null;
}

// compare orders two versions: -1 if a is older, 0 if equal, 1 if a is newer.
// An invalid version is older than every valid one, and equal to another
// invalid one (version.go:33).
export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;

  for (const d of [pa.major - pb.major, pa.minor - pb.minor, pa.patch - pb.patch]) {
    if (d !== 0) return sign(d);
  }
  // A prerelease precedes the release it leads to: v1.2.3-rc1 < v1.2.3.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return sign(byteCompareStr(pa.pre, pb.pre));
}

// less reports whether a is older than b.
export function less(a: string, b: string): boolean {
  return compare(a, b) < 0;
}

function parse(s: string): Parts | null {
  s = s.trim();
  if (s.startsWith('v')) s = s.slice(1);
  // Build metadata never affects ordering, dropped before anything else looks.
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  let pre = '';
  const dash = s.indexOf('-');
  if (dash >= 0) {
    pre = s.slice(dash + 1);
    s = s.slice(0, dash);
  }
  const nums = s.split('.');
  if (nums.length !== 3) return null;
  const out: Parts = { major: 0, minor: 0, patch: 0, pre };
  const dst: (keyof Omit<Parts, 'pre'>)[] = ['major', 'minor', 'patch'];
  for (let i = 0; i < 3; i++) {
    const n = atoi(nums[i]!);
    if (n === null || n < 0) return null;
    out[dst[i]!] = n;
  }
  return out;
}

// atoi mirrors strconv.Atoi: a base-10 integer, optional leading sign, and
// nothing else. Returns null when the string is not a plain integer, so "1.2.x"
// and "1.2.-1" (negative, rejected upstream) are not versions.
function atoi(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function byteCompareStr(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sign(n: number): number {
  if (n < 0) return -1;
  if (n > 0) return 1;
  return 0;
}

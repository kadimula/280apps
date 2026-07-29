// StaticWorker is the platform-supplied serving worker for static-only apps.
// Spec: platform/internal/runtime/cloudflare/embed.go (//go:embed static.js).
//
// Go embeds static.js into the binary at compile time. The TS analog is a
// compiled-in constant, so the module stays self-contained: no filesystem read,
// no build step that must copy static.js next to the output. The bytes are the
// base64 of static.js; the verbatim file lives alongside as the source of truth,
// and static-embed.test.ts asserts this constant equals it byte for byte so the
// two can never drift.
const STATIC_JS_BASE64 =
  'LyoqCiAqIFRoZSBzZXJ2aW5nIHdvcmtlciBmb3Igc3RhdGljLW9ubHkgYXBwcy4KICoKICogU3RhdGljIHNpdGVzIGhhdmUgbm8gc2VydmVyIGNvZGUsIGJ1dCBhIFVzZXIgV29ya2VyIGlzIHN0aWxsIHRoZSB1bml0IHRoZQogKiBkaXNwYXRjaCBuYW1lc3BhY2UgaGFuZHMgYSByZXF1ZXN0IHRvLCBzbyB0aGUgcGxhdGZvcm0gc3VwcGxpZXMgdGhpcyBvbmUuCiAqIEl0IHJlcGxhY2VzIHRoZSBwbGFjZWhvbGRlciBzdHViIHRoZSBDTEkgcHV0cyBpbiB0aGUgbWFuaWZlc3QncyB3b3JrZXIgc2xvdAogKiAoY2xpL2ludGVybmFsL2J1bmRsZSkg4oCUIGEgc2VydmluZyBzdHViIGlzIHN1YnN0cmF0ZS1zcGVjaWZpYyBhbmQgaGFzIG5vCiAqIGJ1c2luZXNzIGJlaW5nIGJ1aWx0IG9uIHRoZSB1c2VyJ3MgbWFjaGluZS4KICoKICogVGhlIGFzc2V0IHJvdXRlciBoYW5kbGVzIGV2ZXJ5IHJlcXVlc3QgdGhhdCBtYXRjaGVzIGEgZmlsZSwgaW5jbHVkaW5nIHRoZQogKiBTUEEgZmFsbGJhY2sgY29uZmlndXJlZCBhdCBkZXBsb3kgdGltZS4gQW55dGhpbmcgcmVhY2hpbmcgZmV0Y2goKSBtYXRjaGVkCiAqIG5vdGhpbmcsIHNvIHRoaXMgaXMgdGhlIGxhc3Qgd29yZC4KICovCmV4cG9ydCBkZWZhdWx0IHsKCWFzeW5jIGZldGNoKHJlcXVlc3QsIGVudikgewoJCXJldHVybiBlbnYuQVNTRVRTLmZldGNoKHJlcXVlc3QpOwoJfSwKfTsK';

export const StaticWorker: Uint8Array = new Uint8Array(Buffer.from(STATIC_JS_BASE64, 'base64'));

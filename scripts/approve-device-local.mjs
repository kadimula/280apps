// approve-device-local.mjs: approve a pending 280 device-login code against the
// LOCAL backend's store, skipping the OIDC/browser session step that a fully
// configured deployment would use. This is the one seam a local push loop cannot
// reach without a login provider; everything downstream (redeem token, bundle,
// upload, Cloudflare deploy) is the real path.
//
// It mirrors handleDeviceApprove (packages/backend/src/api.ts): ensure an account
// for a fixed local subject, then approveDeviceCode(normalizedUserCode, acctId).
//
// Usage:  node --env-file=.env scripts/approve-device-local.mjs <USER-CODE>
//   e.g.  node --env-file=.env scripts/approve-device-local.mjs 4P8N-DCN4

import { randomBytes } from 'node:crypto';
import { open } from '../packages/backend/dist/store/index.js';

const raw = process.argv[2];
if (!raw) {
  console.error('usage: node --env-file=.env scripts/approve-device-local.mjs <USER-CODE>');
  process.exit(2);
}

// Same normalization the API applies to what a human types (api.ts).
const userCode = raw.trim().toUpperCase().replaceAll('-', '');

const dsn = process.env.DATABASE_URL ?? '';
if (dsn === '') {
  console.error('DATABASE_URL is empty (run with: node --env-file=.env ...)');
  process.exit(2);
}
const schema = process.env.DATABASE_SCHEMA || 'platform';

// A stable fake subject so re-runs reuse the same local account.
// Overridable via TWO80_LOCAL_SUBJECT.
const SUBJECT = process.env.TWO80_LOCAL_SUBJECT || 'local-dev';
const nowSecs = () => Math.floor(Date.now() / 1000);
const newAccountId = () => 'acct_' + randomBytes(9).toString('base64url');

const store = await open(dsn, schema);
const acct = await store.ensureAccount(SUBJECT, newAccountId());
const ok = await store.approveDeviceCode(userCode, acct.id, nowSecs());

if (!ok) {
  console.error(
    `approve failed for code ${userCode}: not pending (unknown, expired, or already approved/claimed). ` +
      `Re-run push to mint a fresh code, then approve that one.`,
  );
  process.exit(1);
}
console.log(`approved ${raw} for account ${acct.id} (subject ${SUBJECT})`);
process.exit(0);

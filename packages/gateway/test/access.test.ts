import { describe, expect, it } from 'vitest';
import { GrantsAccess, type GrantsReader } from '../src/access.js';
import type { VerifiedViewer } from '../src/gateway.js';

// A GrantsReader over two fixed maps: one app by script, grants by "appId principal".
function reader(apps: Record<string, string>, grants: string[]): GrantsReader {
  const grantSet = new Set(grants);
  return {
    async appByScript(script) {
      const id = apps[script];
      return id === undefined ? null : { id };
    },
    async grant(appId, principal) {
      return grantSet.has(`${appId} ${principal}`) ? { appRole: 'viewer' } : null;
    },
  };
}

const viewer = (email: string): VerifiedViewer => ({ id: 'usr_1', email, name: 'Test' });
const check = (r: GrantsReader, v: VerifiedViewer, script = 'renewals') =>
  new GrantsAccess(r).check({ viewer: v, appScript: script, host: `${script}.280apps.run` });

describe('GrantsAccess', () => {
  it('allows a viewer named directly by email', async () => {
    const r = reader({ renewals: 'app_1' }, ['app_1 alice@evergreen.com']);
    expect(await check(r, viewer('alice@evergreen.com'))).toEqual({ allow: true });
  });

  it('allows a viewer covered by a domain grant', async () => {
    const r = reader({ renewals: 'app_1' }, ['app_1 domain:evergreen.com']);
    expect(await check(r, viewer('anyone@evergreen.com'))).toEqual({ allow: true });
  });

  it('denies a viewer with no matching grant', async () => {
    const r = reader({ renewals: 'app_1' }, ['app_1 domain:evergreen.com']);
    const decision = await check(r, viewer('mallory@outsider.com'));
    expect(decision.allow).toBe(false);
  });

  it("does not treat one app's grant as access to another", async () => {
    const r = reader({ renewals: 'app_1', sales: 'app_2' }, ['app_1 domain:evergreen.com']);
    const decision = await check(r, viewer('alice@evergreen.com'), 'sales');
    expect(decision.allow).toBe(false);
  });

  it('denies when the app does not exist, without revealing that', async () => {
    const r = reader({}, ['app_1 domain:evergreen.com']);
    const denied = await check(r, viewer('alice@evergreen.com'), 'ghost');
    const missingGrant = await check(reader({ renewals: 'app_1' }, []), viewer('alice@evergreen.com'));
    expect(denied.allow).toBe(false);
    // The reason is identical to the no-grant reason, so existence is not probeable.
    expect(denied).toEqual(missingGrant);
  });
});

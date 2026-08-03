// stampIdentity is the single chokepoint building every container-bound request: it
// must strip forged x-280-* headers AND the platform's own 280_* cookies (the SSO
// session is a portable bearer; untrusted container code must never see it).

import { describe, expect, it } from 'vitest';
import { stampIdentity } from '../src/cookies.js';

const TOKEN = 'minted-token';

function stamped(headers: Record<string, string>): Request {
  return stampIdentity(new Request('https://renewals.280apps.run/', { headers }), TOKEN);
}

describe('stampIdentity', () => {
  it('strips every 280_* cookie and preserves app cookies', () => {
    const out = stamped({
      cookie: '280_session=sess; app_theme=dark; 280_id=idtok; sid=abc123; 280_view=u2',
    });
    expect(out.headers.get('cookie')).toBe('app_theme=dark; sid=abc123');
  });

  it('removes the Cookie header entirely when only 280_* cookies were present', () => {
    const out = stamped({ cookie: '280_session=sess; 280_id=idtok; 280_view=u2' });
    expect(out.headers.get('cookie')).toBeNull();
  });

  it('leaves a request without cookies untouched', () => {
    const out = stamped({});
    expect(out.headers.get('cookie')).toBeNull();
  });

  it('still stamps the minted identity and strips client x-280-* headers', () => {
    const out = stamped({
      cookie: '280_session=sess; app_theme=dark',
      'x-280-identity': 'forged',
      'x-280-user': 'admin@evergreen.com',
    });
    expect(out.headers.get('X-280-Identity')).toBe(TOKEN);
    expect(out.headers.get('x-280-user')).toBeNull();
    expect(out.headers.get('cookie')).toBe('app_theme=dark');
  });
});

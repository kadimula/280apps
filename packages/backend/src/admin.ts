// Site-wide admin identity. The permission model has no such role by design (its
// roles are per-app); the cross-tenant admin read endpoints gate instead on a small
// email allowlist configured through TWO80_ADMIN_EMAILS. One definition of the
// default lives here; the frontend keeps its own copy and enforces independently.

export const DEFAULT_ADMIN_EMAIL = 'kishore@kadimula.com';

// parseAdminEmails turns the comma-separated TWO80_ADMIN_EMAILS into a lowercased
// allowlist, falling back to the single default when unset or empty.
export function parseAdminEmails(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
  return list.length > 0 ? list : [DEFAULT_ADMIN_EMAIL];
}

// isAdmin reports whether an authenticated email is on the site-wide admin
// allowlist, matched case-insensitively.
export function isAdmin(email: string, adminEmails: readonly string[]): boolean {
  const e = email.trim().toLowerCase();
  return e !== '' && adminEmails.includes(e);
}

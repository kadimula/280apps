/**
 * The serving worker for static-only apps.
 *
 * Static sites have no server code, but a User Worker is still the unit the
 * dispatch namespace hands a request to, so the platform supplies this one.
 * It replaces the placeholder stub the CLI puts in the manifest's worker slot
 * (cli/internal/bundle) — a serving stub is substrate-specific and has no
 * business being built on the user's machine.
 *
 * The asset router handles every request that matches a file, including the
 * SPA fallback configured at deploy time. Anything reaching fetch() matched
 * nothing, so this is the last word.
 */
export default {
	async fetch(request, env) {
		return env.ASSETS.fetch(request);
	},
};

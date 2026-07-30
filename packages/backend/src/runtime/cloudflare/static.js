// The serving worker for static-only apps. Static sites have no server code, but
// the dispatch namespace still hands requests to a User Worker, so the platform
// supplies this one in place of the CLI's placeholder stub. The asset router
// already handled every file match and the SPA fallback, so fetch() is the last word.
export default {
	async fetch(request, env) {
		return env.ASSETS.fetch(request);
	},
};

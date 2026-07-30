/**
 * The 280 dispatcher: the only hop in front of user code. The hostname's first
 * label is the app's script name, so routing is a string split and one binding
 * call — no lookup, cache, or db in the request path, safe because app URLs are
 * assigned once at create time and never change (deploysvc). Any future sharing
 * check lands here too, so nothing else may sit in front of tenants.
 */

const RESERVED = new Set(["www", "api", "app", "admin", "dashboard", "status", "assets"]);

/** Cloudflare script naming rules; reject early rather than round-trip a 400. */
const VALID_SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export default {
	async fetch(request, env) {
		const script = scriptFor(new URL(request.url).hostname, env);
		if (!script) return notFound(env, request);

		// get() is lazy: a missing script does not throw here but at fetch() time,
		// mixed with genuine tenant exceptions, so both paths check for it.
		let worker;
		try {
			worker = env.DISPATCHER.get(script);
		} catch {
			return notFound(env, request);
		}

		let response;
		try {
			response = await worker.fetch(request);
		} catch (err) {
			const message = err?.message ?? String(err);
			if (message.includes("Worker not found")) return notFound(env, request);

			// app threw before responding: its failure, not the platform's, shown to its visitors.
			return new Response("This app crashed.\n", {
				status: 502,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		// A 101 upgrade cannot be rebuilt, so it passes through untouched.
		return response;
	},
};

/** @returns {string | null} */
function scriptFor(hostname, env) {
	let label = hostname.split(".")[0];
	// Dev serves apps at <script>-development.280apps.run under the free *.280apps.run
	// wildcard cert; HOST_SUFFIX (dev dispatcher only) strips it back to the script name.
	const suffix = env.HOST_SUFFIX;
	if (suffix && label.length > suffix.length && label.endsWith(suffix)) {
		label = label.slice(0, -suffix.length);
	}
	if (!label || RESERVED.has(label) || !VALID_SCRIPT.test(label)) return null;
	return label;
}

// Unknown hostname is almost always a deleted app or typo; show a page, not a stack
// trace. Rendered inline so a control-plane outage can't turn this into a timeout.
function notFound(env, request) {
	if (request.headers.get("accept")?.includes("application/json")) {
		return Response.json({ error: "app_not_found" }, { status: 404 });
	}
	const home = env.WEB_ORIGIN ?? "https://280apps.com";
	return new Response(
		`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>App not found</title>
<style>
  body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;color:#111;background:#fff;
       display:grid;place-content:center;min-height:100svh;margin:0;padding:2rem;text-align:center}
  a{color:inherit}
  @media (prefers-color-scheme:dark){body{color:#eee;background:#111}}
</style>
<h1>App not found</h1>
<p>This link is wrong, or the app was deleted.</p>
<p><a href="${home}">280</a></p>
`,
		{ status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

/**
 * The 280 dispatcher: the only thing in front of user code.
 *
 * Every request to *.280apps.run lands here. The hostname's first label is the
 * app's script name, so routing is a string split and one binding call — no
 * lookup, no cache, no database in the request path. That is deliberate: app
 * URLs are assigned once at create time and never change (deploysvc), which is
 * what buys the request path having no state to be stale.
 *
 * Cloudflare bills one request for the whole chain, not two, so keeping this
 * the single hop in front of tenants costs nothing. It is also where any future
 * non-unlisted sharing check lands (plan/sharing.html), which is the other
 * reason nothing else may sit here.
 *
 * Deliberately absent from the spike version: the X-Probe header and /p/<script>/
 * path routing. Both let a caller address any script from any hostname, which is
 * a harness affordance and a tenant-isolation hole in production.
 */

/** Hostname labels that are the platform, never an app. */
const RESERVED = new Set(["www", "api", "app", "admin", "dashboard", "status", "assets"]);

/** Cloudflare script naming rules; reject early rather than round-trip a 400. */
const VALID_SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export default {
	async fetch(request, env) {
		const script = scriptFor(new URL(request.url).hostname, env);
		if (!script) return notFound(env, request);

		// get() is lazy: it binds a stub and does not throw for a missing
		// script. "Worker not found" surfaces at fetch() time instead, mixed in
		// with genuine tenant exceptions, so both paths check for it.
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

			// The app threw before producing a response. This is the app's
			// failure, not the platform's, and it is what its visitors see.
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
	// Staging serves apps at <script>-staging.280apps.run, a single label under
	// the zone so the free Universal SSL wildcard (*.280apps.run) covers them; a
	// second-level *.staging.280apps.run would need a paid cert. HOST_SUFFIX is
	// set only on the staging dispatcher and strips that suffix back to the
	// script name. Prod leaves it unset, so prod parsing is byte-for-byte the
	// same as before.
	const suffix = env.HOST_SUFFIX;
	if (suffix && label.length > suffix.length && label.endsWith(suffix)) {
		label = label.slice(0, -suffix.length);
	}
	if (!label || RESERVED.has(label) || !VALID_SCRIPT.test(label)) return null;
	return label;
}

/**
 * An unknown hostname is overwhelmingly a deleted app or a mistyped URL, and
 * the person seeing it was handed a link by a coworker. It gets a page, not a
 * stack trace. Rendered here rather than fetched from the web surface so a
 * control-plane outage cannot turn this into a timeout.
 */
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

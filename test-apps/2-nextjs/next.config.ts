import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// output: "standalone" is required by 280. The deploy adapter consumes the
// standalone tree; `next build` only emits it when the config asks for it.
//
// outputFileTracingRoot pins the trace root to this app so `server.js` lands at
// .next/standalone/server.js. Without it, a lockfile above this directory (as in
// a monorepo) makes Next trace a higher root and nest the output, which the
// deploy adapter cannot find. Harmless once the app stands alone.
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
};

export default nextConfig;

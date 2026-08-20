import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // Watch the linked @two80/sdk dist so tsup --watch rebuilds hot-reload here.
  transpilePackages: ["@two80/sdk"],
};

export default nextConfig;

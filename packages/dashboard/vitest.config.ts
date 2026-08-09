import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The node environment leaves document undefined, matching Next.js SSR, so a
// component that touches document during render fails here exactly as it would
// on the server.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
  },
});

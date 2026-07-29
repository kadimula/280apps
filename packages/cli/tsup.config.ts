import { defineConfig } from "tsup";

// Bundles the single CLI bin into one ESM file with a shebang, the artifact the
// `280` bin in package.json points at and the only thing shipped (files:
// ["dist"]). W2 owns src/*; this config just needs the bin entry to stay stable.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  // @280/contracts is a private workspace package (never published), so it must
  // be inlined into the bundle or `npx two80` fails with EUNSUPPORTEDPROTOCOL on
  // its `workspace:*` spec. zod and @toon-format/toon stay external: they are the
  // CLI's only two runtime dependencies (plan §5), resolved from npm on install.
  noExternal: [/^@280\/contracts(\/.*)?$/],
  // Agents invoke this via `npx two80@latest push`; a shebang lets the shim run
  // it directly.
  banner: { js: "#!/usr/bin/env node" },
});

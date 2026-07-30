import { defineConfig } from "tsup";

// Bundles the CLI bin into one shebang'd ESM file, the only thing shipped (files:
// ["dist"]) and what the `280` bin in package.json points at.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  // @280/contracts is a private workspace package, so it must be inlined or `npx
  // two80` fails with EUNSUPPORTEDPROTOCOL on its `workspace:*` spec. zod and
  // @toon-format/toon stay external: the CLI's only runtime deps, resolved from npm.
  noExternal: [/^@280\/contracts(\/.*)?$/],
  banner: { js: "#!/usr/bin/env node" },
});

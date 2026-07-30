import { defineConfig } from 'tsup';

// Bundles @280/sdk into one self-contained ESM file. @280/contracts is a private
// workspace package, so its identity module must be inlined or an app that installs
// @280/sdk fails on its `workspace:*` spec. The SDK has no runtime dependencies of
// its own (verification uses the platform's WebCrypto), so nothing else is bundled.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  noExternal: [/^@280\/contracts(\/.*)?$/],
});

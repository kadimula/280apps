import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Lint for the TS rewrite workspace (packages/* only). frontend/ and the
// standalone packages/dashboard (Next app, excluded from the pnpm workspace)
// each own their eslint.config.mjs and are intentionally out of this config
// (plan §2/§5: the root workspace must not touch those builds). Fast, non-type-checked
// rules: type errors are the typecheck job's (tsc) responsibility.
export default tseslint.config(
  {
    ignores: ["**/.next/**", "**/dist/**", "**/testdata/**", "**/scripts/**", "platform/**", "packages/dashboard/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts"],
    rules: {
      // Underscore-prefixed args are intentional placeholders.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The Google Sheets vendor library and its types are fenced to the provider folder;
    // they must not leak above the Provider seam, into service.ts, the wire, or the SDK.
    files: ["packages/**/*.ts"],
    ignores: ["packages/backend/src/integrations/google/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@googleapis/*", "googleapis", "googleapis/*"],
              message:
                "Google Sheets vendor types are fenced to packages/backend/src/integrations/google/.",
            },
          ],
        },
      ],
    },
  },
);

import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Lint for the TS rewrite workspace (packages/* only). frontend/ has its own
// eslint.config.mjs and is intentionally out of this config (plan §2/§5: the
// root workspace must not touch the frontend build). Fast, non-type-checked
// rules: type errors are the typecheck job's (tsc) responsibility.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/testdata/**",
      "**/scripts/**",
      "frontend/**",
      "cli/**",
      "platform/**",
      "contracts/**",
      "spike-adapter/**",
    ],
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
);

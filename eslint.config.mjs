import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["apps/web/public/sw.js"], languageOptions: { globals: globals.serviceworker } },
  // A CommonJS script run with node on the staging host during the walkthrough.
  {
    files: ["docs/engineering/staging-walkthrough-2026-10/inspect-outbox.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);

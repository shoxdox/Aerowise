import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/next-env.d.ts", "apps/web/public/map/maplibre/**", "**/test-results/**", "**/playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["apps/web/public/sw.js"], languageOptions: { globals: globals.serviceworker } },
  // SW-12 drill scripts run in node and drive a phone browser (page.evaluate bodies use browser globals).
  { files: ["apps/web/drills/**/*.mjs"], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  // A CommonJS script run with node on the staging host during the walkthrough.
  {
    files: ["docs/engineering/staging-walkthrough-2026-10/inspect-outbox.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Hooks run unconditionally and in the same order on every render. exhaustive-deps is deliberately not enabled.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);

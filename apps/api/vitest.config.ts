import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Test files share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 20000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration tests hit the live Phase 1 OpenSearch cluster; keep them serial
    // and give them a little more time than the default.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});

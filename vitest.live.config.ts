// Live-server tests: test/live/global-setup.ts starts the server named by
// WARP_SQL_JS_TEST_SERVER_BINARY and fails the run without it, or when no test reached it.
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "#platform": fileURLToPath(new URL("./src/platform/node.ts", import.meta.url)) } },
  test: {
    include: ["test/live/**/*.test.ts"],
    globalSetup: ["test/live/global-setup.ts"],
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One server, many sessions: files run one at a time so timing-based tests (cancel,
    // statement timeouts) don't compete for the server's threads.
    fileParallelism: false,
  },
});

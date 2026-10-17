import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "#platform": fileURLToPath(new URL("./src/platform/node.ts", import.meta.url)) } },
  test: {
    include: ["test/unit/**/*.test.ts"],
    passWithNoTests: false,
  },
});

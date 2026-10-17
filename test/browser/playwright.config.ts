// The browser smoke test: the example page and the client, in Chromium and WebKit, against
// a local Warp SQL server that allows the page's origin (CORS). The server is the one
// named by WARP_SQL_JS_TEST_SERVER_BINARY, as for the live tests; without it the run fails.
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env["WARP_SQL_JS_EXAMPLE_PORT"] ?? 5173);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  timeout: 60_000,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node examples/browser/serve.mjs",
    cwd: "../..",
    url: `http://localhost:${port}`,
    env: { PORT: String(port) },
    reuseExistingServer: false,
  },
});

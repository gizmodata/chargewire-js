// Client certificate sign-in in Chromium and WebKit: the example page, on another origin
// than the server, signs in with the browser's client certificate (Playwright's
// clientCertificates stand in for the user's certificate store). The server is the one
// named by WARP_SQL_JS_TEST_SERVER_BINARY; it must offer certificate sign-in and allow
// credentials for the page's origin (warp-sql feat/cors-credentials). Without it the run fails.
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env["WARP_SQL_JS_EXAMPLE_PORT"] ?? 5173);

export default defineConfig({
  testDir: ".",
  testMatch: "mtls.spec.ts",
  globalSetup: "./mtls-setup.ts",
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

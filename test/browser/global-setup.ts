// Starts a Warp SQL server that allows the example page's origin, and hands its address to
// the tests through the environment. Fails without WARP_SQL_JS_TEST_SERVER_BINARY.
import { launchServer } from "../live/harness.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const port = Number(process.env["WARP_SQL_JS_EXAMPLE_PORT"] ?? 5173);
  const server = await launchServer(["--cors-origin", `http://localhost:${port}`]);
  process.env["WARP_SQL_JS_BROWSER_SERVER"] = JSON.stringify({ host: server.host, password: server.password });
  return () => server.stop();
}

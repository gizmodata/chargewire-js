import { expect, test } from "@playwright/test";

const setup = JSON.parse(process.env["WARP_SQL_JS_BROWSER_MTLS"] ?? "null") as {
  host: string;
  certPem: string;
  keyPem: string;
} | null;
if (setup === null) throw new Error("the global setup did not start a server");
const port = setup.host.split(":")[1]!;
const examplePort = Number(process.env["WARP_SQL_JS_EXAMPLE_PORT"] ?? 5173);

// Playwright presents client certificates through a proxy of its own; WebKit on macOS
// bypasses it for loopback addresses, except for Playwright's alias local.playwright.
const serverUrl = (project: string): string =>
  `https://${project === "webkit" ? "local.playwright" : "127.0.0.1"}:${port}`;

test.use({
  // The server's own certificate is from the test CA.
  ignoreHTTPSErrors: true,
  // The browser holds the client certificate, as a user's certificate store would (for
  // this project's spelling of the server's address).
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  clientCertificates: async ({}, use, info) => {
    await use([
      { origin: serverUrl(info.project.name), cert: Buffer.from(setup.certPem), key: Buffer.from(setup.keyPem) },
    ]);
  },
});

type Client = typeof import("../../src/index.js");

/** Signs in with the certificate from the page, runs a query and reads a split result. */
async function signIn(page: import("@playwright/test").Page, url: string) {
  return page.evaluate(
    async ({ url }) => {
      const { connect, WarpSqlError } = (globalThis as unknown as { warpSql: Client }).warpSql;
      try {
        const conn = await connect({ url, authType: "client_certificate" });
        const seven = Number((await conn.query("SELECT 7 AS v")).getChild("v")!.get(0));
        let rows = 0;
        for await (const batch of conn.stream("SELECT i FROM range(1000000) t(i) ORDER BY i DESC")) {
          rows += batch.numRows;
        }
        await conn.close();
        return { seven, rows, code: "" };
      } catch (err) {
        return { seven: 0, rows: 0, code: err instanceof WarpSqlError ? err.code : String(err) };
      }
    },
    { url },
  );
}

test("a page on an allowed origin signs in with the browser's client certificate", async ({ page }, info) => {
  await page.goto("/"); // http://localhost:<port>, the allowed origin
  const result = await signIn(page, serverUrl(info.project.name));
  expect(result.code).toBe("");
  expect(result.seven).toBe(7);
  expect(result.rows).toBe(1_000_000); // each partition's request was credentialed too
});

test("a page on another origin cannot", async ({ page }, info) => {
  await page.goto(`http://127.0.0.1:${examplePort}/`); // not on the server's allow-list
  const result = await signIn(page, serverUrl(info.project.name));
  expect(result.code).toBe("transport_error"); // the browser blocks the answer (CORS)
});

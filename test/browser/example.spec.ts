import { expect, test } from "@playwright/test";

const server = JSON.parse(process.env["WARP_SQL_JS_BROWSER_SERVER"] ?? "null") as {
  host: string;
  password: string;
} | null;
if (server === null) throw new Error("the global setup did not start a server");
const url = `http://${server.host}`;

test.beforeEach(async ({ page }) => {
  // Credentials never travel in a URL: watch every request the page makes.
  page.on("request", (request) => {
    expect(request.url()).not.toContain(encodeURIComponent(server.password));
    expect(request.url()).not.toContain(server.password);
  });
  await page.goto(`/?url=${encodeURIComponent(url)}&username=warp_test`);
});

test("the example page signs in, runs a query and shows the rows", async ({ page }) => {
  await page.getByLabel("Password").fill(server.password);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByRole("status")).toContainText("1 row(s)");
  await expect(page.locator("#result")).toContainText("hello from Warp SQL");
  await expect(page.locator("#result")).toContainText("42");
});

test("a server error shows its code", async ({ page }) => {
  await page.getByLabel("Password").fill(server.password);
  await page.getByLabel("SQL").fill("SELEC 1");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByRole("status")).toContainText("sql_error");
  // Its positive twin, on the same connection.
  await page.getByLabel("SQL").fill("SELECT 7 AS seven");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByRole("status")).toContainText("1 row(s)");
});

test("the client streams, splits, uploads and cancels in the browser", async ({ page }) => {
  const result = await page.evaluate(
    async ({ url, password }) => {
      const { connect, WarpSqlError, tableFromArrays } = (
        globalThis as unknown as {
          warpSql: typeof import("../../src/index.js") & {
            tableFromArrays: typeof import("apache-arrow").tableFromArrays;
          };
        }
      ).warpSql;
      const conn = await connect({ url, username: "warp_test", password });
      let rows = 0;
      const stream = conn.stream("SELECT i FROM range(1000000) t(i) ORDER BY i DESC");
      let first: unknown;
      for await (const batch of stream) {
        first ??= Number(batch.getChildAt(0)!.get(0));
        rows += batch.numRows;
      }
      const partitions = await stream.partitions();
      // Compressed results, each codec's decoder loaded on use, where the server offers it.
      const compressed: Record<string, string> = {};
      for (const codec of ["lz4_frame", "zstd"] as const) {
        if (!conn.capabilities.has(`ipc_compression_${codec}`)) continue;
        const t = await conn.query(
          "SELECT i, hash(i)::DOUBLE AS h, 'v' || i AS s FROM range(300000) t(i) ORDER BY i",
          undefined,
          { ipcCompression: codec },
        );
        compressed[codec] = `${t.numRows} ${String(t.getChild("s")!.get(299999))}`;
      }
      // An upload from the browser: held in memory (browsers cannot stream request bodies over HTTP/1.1).
      const ingested = await conn.ingest(
        "browser_t",
        tableFromArrays({ v: Int32Array.from({ length: 50000 }, (_, i) => i) }),
        {
          mode: "replace",
        },
      );
      const controller = new AbortController();
      const long = conn.query("SELECT sum(a.range * b.range) FROM range(100000000) a, range(100000) b", undefined, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 500);
      let cancelCode = "";
      try {
        await long;
      } catch (err) {
        cancelCode = err instanceof WarpSqlError ? err.code : String(err);
      }
      const after = Number((await conn.query("SELECT 42 AS v")).getChild("v")!.get(0));
      let wrongPassword = "";
      try {
        await connect({ url, username: "warp_test", password: "wrong" });
      } catch (err) {
        wrongPassword = err instanceof WarpSqlError ? err.code : String(err);
      }
      await conn.close();
      return {
        rows,
        first,
        partitions,
        ingested,
        cancelCode,
        after,
        wrongPassword,
        compressed,
        splits: conn.capabilities.has("result_partitions"),
      };
    },
    { url, password: server.password },
  );
  expect(result.rows).toBe(1_000_000);
  expect(result.first).toBe(999_999);
  if (result.splits) expect(result.partitions).toBeGreaterThan(1);
  expect(result.partitions).toBeLessThanOrEqual(4); // the browser build's default
  expect(result.ingested).toBe(50000);
  expect(result.cancelCode).toBe("statement_cancelled");
  expect(result.after).toBe(42);
  expect(result.wrongPassword).toBe("invalid_credentials");
  expect(result.compressed).toEqual({ lz4_frame: "300000 v299999", zstd: "300000 v299999" });
});

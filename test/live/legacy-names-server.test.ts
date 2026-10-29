// Licensed under the Apache License, Version 2.0.
//
// A server from before the protocol's rename (the last pre-rename warp-duckdb), reached with
// current connection strings: the client finds it at the old base path and speaks its
// spelling. The binary is CHARGEWIRE_JS_TEST_LEGACY_SERVER_BINARY; without it these tests skip.

import { existsSync } from "node:fs";

import { tableFromArrays } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Connection, ErrorCode, connect } from "../../src/index.js";
import { type RunningServer, launchServer, testUsername } from "./harness.js";
import { expectCode, longQuery, numbers, quiet, reached, scalar } from "./helpers.js";

const binary = process.env["CHARGEWIRE_JS_TEST_LEGACY_SERVER_BINARY"] ?? "";
const present = binary !== "" && existsSync(binary);
if (!present) console.log(`skipping the pre-rename server tests: no binary at ${JSON.stringify(binary)}`);

interface Seen {
  method: string;
  path: string;
  sent: string[];
  answered: string[];
}

describe.skipIf(!present)("a server from before the rename", () => {
  let server: RunningServer;
  let conn: Connection;
  const seen: Seen[] = [];
  const recording: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const resp = await fetch(input, init);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      sent: [...new Headers(init?.headers).keys()],
      answered: [...resp.headers.keys()],
    });
    return resp;
  };

  beforeAll(async () => {
    server = await launchServer([], {}, { binary, passwordEnv: "WARP_DUCKDB_PASSWORD" });
    reached();
    conn = await connect({
      url: `chargewire://${server.host}?tls=false`,
      username: testUsername,
      password: server.password,
      fetch: recording,
      logger: quiet,
    });
  });

  afterAll(async () => {
    await conn?.close();
    await server?.stop();
  });

  test("connects with a current URL: one 404 at the default base path, then the old one", () => {
    expect(conn.server.protocol).toBe("chargewire");
    expect(conn.server.server?.name).toBe("warp-duckdb");
    expect(seen.slice(0, 2).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /chargewire", "GET /warp"]);
    expect(seen.slice(2).every((r) => r.path.startsWith("/warp/"))).toBe(true);
  });

  test("queries, asking for partitions and compression, in the old header spelling", async () => {
    expect(await scalar(conn, "SELECT 41 + 1")).toBe(42);
    const from = seen.length;
    const table = await conn.query("SELECT range AS i FROM range(200000)", undefined, {
      resultPartitions: 4,
      resultOrder: "any",
      ipcCompression: "zstd",
    });
    expect(table.numRows).toBe(200000);
    expect(numbers(table).reduce((a, b) => a + b, 0)).toBe((199999 * 200000) / 2);
    const sent = seen.slice(from).flatMap((r) => r.sent);
    expect(sent).toContain("warp-result-partitions");
    expect(sent).toContain("warp-ipc-compression");
    expect(sent.some((n) => n.startsWith("chargewire-"))).toBe(false);
    // The answer's protocol headers, read in the old spelling (the client reads them renamed).
    const answered = seen.slice(from).flatMap((r) => r.answered);
    expect(answered).toContain("warp-statement-id");
    expect(answered).toContain("warp-ipc-compression");
  });

  test("a prepared statement with parameters", async () => {
    await conn.execute("CREATE OR REPLACE TABLE lp (id INTEGER, name VARCHAR)");
    const insert = await conn.prepare("INSERT INTO lp VALUES (?, ?)");
    expect(insert.parameterSchema?.fields.length).toBe(2);
    await insert.execute([1, "one"]);
    await insert.execute([2, "two"]);
    await insert.close();
    const select = await conn.prepare("SELECT name FROM lp WHERE id = ?");
    const t = await select.query([2]);
    expect(t.getChild("name")!.get(0)).toBe("two");
    await select.close();
  });

  test("an upload (ingest)", async () => {
    const rows = tableFromArrays({ k: Int32Array.from([1, 2, 3]), v: ["a", "b", "c"] });
    expect(await conn.ingest("li", rows, { mode: "replace" })).toBe(3);
    expect(await conn.ingest("li", rows, { mode: "append" })).toBe(3);
    expect(await scalar(conn, "SELECT count(*) FROM li")).toBe(6);
  });

  test("a SQL error keeps its code, SQLSTATE and request id; its type is in the current spelling", async () => {
    const err = await expectCode(conn.query("SELECT * FROM no_such_table_here"), ErrorCode.sqlError);
    expect(err.sqlstate).toBe("42P01");
    expect(err.type).toBe("urn:chargewire:error:sql_error");
    expect(err.requestId).toMatch(/^r_/); // from the old request-id header
    expect(await scalar(conn, "SELECT 1")).toBe(1); // the session is still usable
  });

  test("the server's statement timeout (sent in the old header)", async () => {
    const err = await expectCode(
      conn.execute(longQuery, undefined, { statementTimeoutMs: 500 }),
      ErrorCode.statementTimeout,
    );
    expect(err.cancelReason).toBe("timeout");
    expect(await scalar(conn, "SELECT 2")).toBe(2);
  });

  test("table metadata: a column default under the old metadata key", async () => {
    await conn.execute("CREATE OR REPLACE TABLE ld (id INTEGER NOT NULL, label VARCHAR DEFAULT 'xyz')");
    const columns = await conn.metadata.columns({ tableNameFilterPattern: "ld" });
    expect(columns.map((c) => c.columnName)).toEqual(["id", "label"]);
    expect(columns[1]!.defaultValue).toContain("xyz");
    expect(columns[0]!.nullable).toBe(false);
  });

  test("an old connection string reaches it too", async () => {
    reached();
    const old = await connect({
      url: `warp://${server.host}?tls=false`,
      username: testUsername,
      password: server.password,
      logger: quiet,
    });
    expect(await scalar(old, "SELECT 3")).toBe(3);
    await old.close();
  });
});

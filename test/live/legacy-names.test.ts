// Licensed under the Apache License, Version 2.0.
//
// A connection string saved before the protocol's rename still connects and queries, and a
// current server is never asked anything at the old base path.

import { tableFromArrays } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ErrorCode, connect } from "../../src/index.js";
import { testUsername } from "./harness.js";
import { expectCode, quiet, reached, scalar, shared } from "./helpers.js";

describe("connection strings from before the rename", () => {
  test.each([`warp://${shared.host}?tls=false`, `warp://${shared.host}/warp?tls=false`, `http://${shared.host}/warp`])(
    "%s connects and runs a query",
    async (url) => {
      reached();
      const conn = await connect({ url, username: testUsername, password: shared.password, logger: quiet });
      try {
        expect(conn.server.protocol).toBe("chargewire");
        expect(await scalar(conn, "SELECT 41 + 1")).toBe(42);
      } finally {
        await conn.close();
      }
    },
  );

  test("a current server is never asked at the old base path, in any spelling of its URL", async () => {
    const paths: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      paths.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname);
      return fetch(input, init);
    };
    for (const url of [`chargewire://${shared.host}?tls=false`, `warp://${shared.host}?tls=false`]) {
      reached();
      const conn = await connect({
        url,
        username: testUsername,
        password: shared.password,
        fetch: recording,
        logger: quiet,
      });
      try {
        expect(await scalar(conn, "SELECT 1")).toBe(1);
        const p = await conn.prepare("SELECT ?::INTEGER AS x");
        expect(Number((await p.query([5])).getChild("x")!.get(0))).toBe(5);
        await p.close();
        await conn.ingest("ln_new", tableFromArrays({ k: Int32Array.from([1]) }), { mode: "replace" });
        await conn.metadata.columns({ tableNameFilterPattern: "ln_new" });
        await expectCode(conn.query("SELECT * FROM no_such_table_here"), ErrorCode.sqlError);
        expect((await conn.query("SELECT range FROM range(1000)", undefined, { resultPartitions: 2 })).numRows).toBe(
          1000,
        );
      } finally {
        await conn.close();
      }
    }
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.filter((p) => p === "/chargewire").length).toBe(2); // discovered once per connection
    expect(paths.every((p) => p === "/chargewire" || p.startsWith("/chargewire/"))).toBe(true);
  });
});

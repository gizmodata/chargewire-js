// Licensed under the Apache License, Version 2.0.

import { Type } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ErrorCode, WarpSqlError, connect } from "../../src/index.js";
import { serverName, testUsername } from "./harness.js";
import { FaultProxy, expectCode, numbers, open, quiet, reached, scalar, shared } from "./helpers.js";

describe("queries", () => {
  test("SELECT 1 on the named server", async () => {
    const conn = await open();
    expect(conn.server.server?.name).toBe(serverName());
    const table = await conn.query("SELECT 1 AS one");
    expect(table.numRows).toBe(1);
    expect(table.schema.fields.map((f) => f.name)).toEqual(["one"]);
    expect(Number(table.getChild("one")!.get(0))).toBe(1);
  });

  test("every spelling of a plain-HTTP URL reaches the same server", async () => {
    for (const url of [
      `warp://${shared.host}?tls=false`,
      `http://${shared.host}`,
      `http://${shared.host}/warp`,
      `http://${shared.host}/warp/`,
    ]) {
      reached();
      const conn = await connect({ url, username: testUsername, password: shared.password, logger: quiet });
      expect(await scalar(conn, "SELECT 7")).toBe(7);
      await conn.close();
    }
    // A base path the server doesn't serve is not a Warp SQL server.
    await expectCode(
      connect({ url: `http://${shared.host}/nope`, username: testUsername, password: shared.password }),
      ErrorCode.clientProtocolError,
    );
  });

  test("a result of many batches arrives complete and in order", async () => {
    const conn = await open({ resultPartitions: 1 });
    const table = await conn.query("SELECT i FROM range(2000000) t(i)");
    const values = numbers(table, "i");
    expect(values.length).toBe(2_000_000);
    expect(values.every((v, i) => v === i)).toBe(true);
    expect(table.batches.length).toBeGreaterThan(1);
  });

  test("types round trip", async () => {
    const conn = await open();
    const table = await conn.query(
      "SELECT 42::INTEGER AS i, 'text' AS s, 2.5::DOUBLE AS d, true AS b, NULL::INTEGER AS n, " +
        "DATE '2026-10-17' AS dt, 123.45::DECIMAL(10,2) AS dec, 9223372036854775807::BIGINT AS big, " +
        "TIMESTAMP '2026-10-17 12:34:56.789' AS ts, [1, 2, NULL] AS l, {'a': 1, 'b': 'x'} AS st, '\\xAA\\xBB'::BLOB AS bl",
    );
    const types = Object.fromEntries(table.schema.fields.map((f) => [f.name, f.typeId]));
    expect(types).toMatchObject({
      i: Type.Int,
      s: Type.Utf8,
      d: Type.Float,
      b: Type.Bool,
      n: Type.Int,
      dt: Type.Date,
      dec: Type.Decimal,
      big: Type.Int,
      ts: Type.Timestamp,
      l: Type.List,
      st: Type.Struct,
      bl: Type.Binary,
    });
    const row = table.get(0)!;
    expect(row.i).toBe(42);
    expect(row.s).toBe("text");
    expect(row.d).toBe(2.5);
    expect(row.b).toBe(true);
    expect(row.n).toBeNull();
    expect(new Date(row.dt as number).toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(row.big).toBe(9223372036854775807n);
    expect([...(row.l as Iterable<unknown>)].map((v) => (v === null ? null : Number(v)))).toEqual([1, 2, null]);
    expect((row.st as { toJSON(): unknown }).toJSON()).toMatchObject({ b: "x" });
    expect(Array.from(row.bl as Uint8Array)).toEqual([0xaa, 0xbb]);
  });

  test("DDL and DML run on submit; query returns an empty table, execute the count", async () => {
    const conn = await open();
    const created = await conn.query("CREATE OR REPLACE TABLE q_ddl (v INTEGER)");
    expect(created.numRows).toBe(0);
    expect(created.numCols).toBe(0);
    expect(await conn.execute("INSERT INTO q_ddl VALUES (1), (2), (3)")).toBe(3);
    expect(await conn.execute("UPDATE q_ddl SET v = v + 1 WHERE v > ?", [1])).toBe(2);
    expect(await conn.execute("CREATE OR REPLACE TABLE q_ddl2 (v INTEGER)")).toBeNull(); // DDL: not counted
    expect(await scalar(conn, "SELECT sum(v)::BIGINT FROM q_ddl")).toBe(8);
  });

  test("RETURNING yields rows and persists", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE q_ret (id INTEGER, name VARCHAR)");
    const table = await conn.query("INSERT INTO q_ret VALUES (1, 'a'), (2, 'b') RETURNING id");
    expect(numbers(table)).toEqual([1, 2]);
    expect(await scalar(conn, "SELECT count(*) FROM q_ret")).toBe(2);
  });

  test("RETURNING persists even when its rows are never read", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE q_ret2 (id INTEGER)");
    const stream = conn.stream("INSERT INTO q_ret2 SELECT * FROM range(100000) RETURNING id");
    await stream.schema();
    await stream.close(); // walk away: a write runs to its end with its rows discarded (§6.8)
    expect(await scalar(conn, "SELECT count(*) FROM q_ret2")).toBe(100000);
  });

  test("a string literal containing RETURNING is just a value", async () => {
    const conn = await open();
    const table = await conn.query("SELECT 'INSERT INTO x RETURNING y' AS s");
    expect(table.get(0)!.s).toBe("INSERT INTO x RETURNING y");
  });

  test("bind parameters: positional, numbered, named, null with a cast, exact bigints", async () => {
    const conn = await open();
    const positional = await conn.query("SELECT ? + 1 AS x, ?::VARCHAR AS s", [41, "hi"]);
    expect(positional.get(0)!.toJSON()).toMatchObject({ x: 42n, s: "hi" }); // ? + 1 is BIGINT
    const numbered = await conn.query("SELECT $2::VARCHAR || $1::VARCHAR AS s", ["b", "a"]);
    expect(numbered.get(0)!.s).toBe("ab");
    const named = await conn.query("SELECT $region::VARCHAR AS r, $year::INTEGER AS y", { region: "EU", year: 2026 });
    expect(named.get(0)!.toJSON()).toMatchObject({ r: "EU", y: 2026 });
    const nulls = await conn.query("SELECT CAST(? AS INTEGER) IS NULL AS isnull", [null]);
    expect(nulls.get(0)!.isnull).toBe(true);
    const big = await conn.query("SELECT ?::BIGINT AS b", [9223372036854775807n]);
    expect(big.get(0)!.b).toBe(9223372036854775807n);
    // A parameter is a value, never SQL text.
    const injected = await conn.query("SELECT ?::VARCHAR AS s", ["1; DROP TABLE x"]);
    expect(injected.get(0)!.s).toBe("1; DROP TABLE x");
  });

  test("integer parameters beyond 64 bits keep their exact value (§6.1), or are refused", async () => {
    const conn = await open();
    const wide = [
      2n ** 63n - 1n,
      2n ** 64n - 1n,
      2n ** 64n,
      10n ** 38n - 1n,
      2n ** 127n,
      2n ** 128n - 1n,
      -(2n ** 63n) - 1n,
      -(2n ** 127n),
    ];
    for (const value of wide) {
      try {
        const table = await conn.query("SELECT CAST(? AS VARCHAR) AS t", [value]);
        expect(table.get(0)!.t, String(value)).toBe(String(value)); // never a rounded double
      } catch (err) {
        expect(WarpSqlError.is(err, ErrorCode.badRequest), String(err)).toBe(true);
      }
    }
  });

  test("a Number beyond the safe integers binds as the double it is, not as other digits", async () => {
    // JSON.stringify(2 ** 63) is 9223372036854776000: a server reading that exactly binds an
    // integer 192 too large. The client writes such a Number in exponent form.
    const conn = await open();
    const exact = await conn.query(
      "SELECT CAST(? AS HUGEINT) = 9223372036854775808::HUGEINT AS a, CAST(? AS HUGEINT) = 18446744073709551616::HUGEINT AS b, CAST(? AS DOUBLE) = 1e300 AS c",
      [2 ** 63, 2 ** 64, 1e300],
    );
    expect(exact.get(0)!.toJSON()).toEqual({ a: true, b: true, c: true });
  });

  test("parameters JSON cannot carry are refused before anything is sent", async () => {
    const conn = await open();
    const err = await expectCode(
      conn.query("SELECT ?", [new Date() as unknown as string]),
      ErrorCode.clientInvalidArgument,
    );
    expect(err.message).toContain("Arrow");
    await expectCode(conn.query("SELECT ?", [Number.NaN]), ErrorCode.clientInvalidArgument);
    // Its positive twin: the same value as a string works.
    expect((await conn.query("SELECT ?::DATE AS d", ["2026-10-17"])).numRows).toBe(1);
  });

  test("a server error is a WarpSqlError with code, status, request id and the server's text", async () => {
    const conn = await open();
    const err = await expectCode(conn.query("SELEC 1"), ErrorCode.sqlError);
    expect(err.status).toBe(400);
    expect(err.requestId).toMatch(/^r_/);
    expect(err.detail).toContain("Parser Error");
    expect(err).toBeInstanceOf(WarpSqlError);
    // The connection is fine afterwards.
    expect(await scalar(conn, "SELECT 1")).toBe(1);
  });

  test("a statement that fails while it runs is execution_error, a 422 (never a 5xx), naming the statement (§6.1, §11)", async () => {
    for (const options of [{}, { async: true }]) {
      const conn = await open(options);
      const err = await expectCode(conn.query("SELECT error('runtime boom') AS v"), ErrorCode.executionError);
      expect(err.message).toContain("runtime boom");
      expect(err.status).toBe(422);
      expect(await scalar(conn, "SELECT 1")).toBe(1);
      const update = await expectCode(conn.execute("SELECT error('runtime boom')"), ErrorCode.executionError);
      expect(update.status).toBe(422);
    }
  });

  test("a missing table is sql_error with SQLSTATE 42P01 when the server sends one", async () => {
    const conn = await open();
    const err = await expectCode(conn.query("SELECT * FROM no_such_table_here"), ErrorCode.sqlError);
    if (err.sqlstate !== undefined) expect(err.sqlstate).toBe("42P01");
  });

  test("stream exposes the schema, the statement id and the batches", async () => {
    const conn = await open({ resultPartitions: 1 });
    const stream = conn.stream("SELECT i FROM range(300000) t(i)");
    const schema = await stream.schema();
    expect(schema.fields[0]!.name).toBe("i");
    expect(stream.statementId).toBeTruthy();
    let rows = 0;
    for await (const batch of stream) rows += batch.numRows;
    expect(rows).toBe(300000);
  });

  test("a statement document's count comes through stream().rowsAffected()", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE q_cnt (v INTEGER)");
    const stream = conn.stream("INSERT INTO q_cnt VALUES (1), (2)");
    expect(await stream.rowsAffected()).toBe(2);
    expect((await stream.toTable()).numRows).toBe(0);
  });

  test("connections are reused across statements", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ resultPartitions: 1 }, proxy.info);
    // 80 rounds: when finished bodies were cancelled instead of read out, a few connections
    // were lost along the way (8 here); read out, the pool keeps the same few.
    for (let i = 0; i < 80; i++) {
      expect((await conn.query("SELECT * FROM range(1000)")).numRows).toBe(1000);
      expect(await conn.execute("SELECT 1")).toBeNull();
    }
    expect(proxy.connections).toBeLessThanOrEqual(4);
  });

  test("a closed connection refuses work", async () => {
    const conn = await open();
    await conn.close();
    await expectCode(conn.query("SELECT 1"), ErrorCode.clientConnectionClosed);
  });
});

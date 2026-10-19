// Licensed under the Apache License, Version 2.0.

import { DurationNanosecond, RecordBatch, Table, makeVector, tableFromArrays, vectorFromArray } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ErrorCode } from "../../src/index.js";
import { FaultProxy, expectCode, isPost, numbers, open, scalar } from "./helpers.js";

const keyValues = (keys: bigint[], values: (string | null)[]): Table =>
  tableFromArrays({ k: BigInt64Array.from(keys), v: values as string[] });

describe("bulk ingest", () => {
  test("modes: create, append, replace, create_append", async () => {
    const conn = await open();
    await conn.execute("DROP TABLE IF EXISTS ing_modes");
    const rows = keyValues([1n, 2n, 3n], ["alice", "bob", null]);
    expect(await conn.ingest("ing_modes", rows, { mode: "create" })).toBe(3);
    expect(await conn.ingest("ing_modes", rows, { mode: "append" })).toBe(3);
    expect(await scalar(conn, "SELECT count(*) FROM ing_modes")).toBe(6);
    expect(await conn.ingest("ing_modes", rows, { mode: "replace" })).toBe(3);
    expect(await scalar(conn, "SELECT count(*) FROM ing_modes")).toBe(3);
    expect(await conn.ingest("ing_modes", rows)).toBe(3); // create_append is the default
    expect(await scalar(conn, "SELECT count(*) FROM ing_modes")).toBe(6);
    const back = await conn.query("SELECT DISTINCT k, v FROM ing_modes ORDER BY k");
    expect(back.get(2)!.v).toBeNull();
  });

  test("create refuses an existing table (42P07); append needs one (42P01)", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE ing_exists (k BIGINT, v VARCHAR)");
    const rows = keyValues([1n], ["a"]);
    const exists = await expectCode(conn.ingest("ing_exists", rows, { mode: "create" }), ErrorCode.sqlError);
    expect(exists.sqlstate).toBe("42P07");
    await conn.execute("DROP TABLE IF EXISTS ing_missing");
    const missing = await expectCode(conn.ingest("ing_missing", rows, { mode: "append" }), ErrorCode.sqlError);
    expect(missing.sqlstate).toBe("42P01");
    // Their positive twins.
    expect(await conn.ingest("ing_exists", rows, { mode: "append" })).toBe(1);
    expect(await conn.ingest("ing_missing", rows, { mode: "create" })).toBe(1);
  });

  test("target catalog and schema, and temporary tables", async () => {
    const conn = await open();
    await conn.execute("ATTACH IF NOT EXISTS ':memory:' AS ing_cat");
    await conn.execute("CREATE SCHEMA IF NOT EXISTS ing_cat.ing_schema");
    await conn.execute("DROP TABLE IF EXISTS ing_cat.ing_schema.placed");
    expect(
      await conn.ingest("placed", keyValues([1n, 2n], ["a", "b"]), {
        catalog: "ing_cat",
        schema: "ing_schema",
        mode: "create",
      }),
    ).toBe(2);
    expect(await scalar(conn, "SELECT count(*) FROM ing_cat.ing_schema.placed")).toBe(2);
    expect(await conn.ingest("ing_temp", keyValues([1n], ["a"]), { temporary: true })).toBe(1);
    expect(await scalar(conn, "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'ing_temp' AND temporary")).toBe(
      1,
    );
    const other = await open();
    await expectCode(other.query("SELECT * FROM ing_temp"), ErrorCode.sqlError); // temporary: this session only
  });

  test("a large upload streams and arrives whole", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    const n = 2_000_000;
    async function* batches(): AsyncGenerator<RecordBatch> {
      for (let start = 0; start < n; start += 100_000) {
        const ids = BigInt64Array.from({ length: 100_000 }, (_, i) => BigInt(start + i));
        yield tableFromArrays({ id: ids, x: Float64Array.from(ids, (v) => Number(v) / 2) }).batches[0]!;
      }
    }
    expect(await conn.ingest("ing_big", batches(), { mode: "replace" })).toBe(n);
    const sums = await conn.query("SELECT count(*) AS c, sum(id)::DOUBLE AS s FROM ing_big");
    expect(Number(sums.get(0)!.c)).toBe(n);
    expect(sums.get(0)!.s).toBe((n * (n - 1)) / 2);
    const upload = proxy.requests(isPost("/ingest"))[0]!;
    expect(upload.headers["transfer-encoding"]).toBe("chunked"); // over 16 MiB: streamed, not buffered
  });

  test("a small upload is sent with its length (kept in memory, so it can be retried)", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    expect(await conn.ingest("ing_small", keyValues([1n], ["a"]), { mode: "replace" })).toBe(1);
    const upload = proxy.requests(isPost("/ingest"))[0]!;
    expect(upload.headers["content-length"]).toBeDefined();
    expect(upload.headers["idempotency-key"]).toMatch(/^k_/);
  });

  test("record batches and sync iterables are accepted too", async () => {
    const conn = await open();
    const table = keyValues([1n, 2n], ["a", "b"]);
    expect(await conn.ingest("ing_kinds", table.batches[0]!, { mode: "replace" })).toBe(2);
    expect(await conn.ingest("ing_kinds", [table.batches[0]!, table.batches[0]!], { mode: "append" })).toBe(4);
  });

  test("an empty table creates the table", async () => {
    const conn = await open();
    await conn.execute("DROP TABLE IF EXISTS ing_empty");
    const empty = tableFromArrays({ k: BigInt64Array.from([]), v: [] as string[] });
    expect(await conn.ingest("ing_empty", empty, { mode: "create" })).toBe(0);
    const cols = await conn.metadata.columns({ tableNameFilterPattern: "ing_empty" });
    expect(cols.map((c) => c.columnName)).toEqual(["k", "v"]);
  });

  test("a type the server cannot keep exactly is refused, never stored as text (§8.1)", async () => {
    const conn = await open();
    const durations = new Table({
      d: makeVector({ type: new DurationNanosecond(), data: BigInt64Array.from([1_500_000_123n]) }),
    });
    await expectCode(conn.ingest("ing_ns", durations, { mode: "replace" }), ErrorCode.unsupportedArrowType);
    // Its positive twin: a type the server keeps.
    expect(await conn.ingest("ing_ns_ok", new Table({ d: vectorFromArray([1n]) }), { mode: "replace" })).toBe(1);
  });

  test("ingest refuses what it cannot send", async () => {
    const conn = await open();
    await expectCode(conn.ingest("", keyValues([1n], ["a"])), ErrorCode.clientInvalidArgument);
    await expectCode(conn.ingest("x", [] as RecordBatch[]), ErrorCode.clientInvalidArgument);
    await expectCode(
      conn.ingest("x", keyValues([1n], ["a"]), { mode: "upsert" as "append" }),
      ErrorCode.clientInvalidArgument,
    );
    expect(numbers(await conn.query("SELECT 1"))).toEqual([1]);
  });
});

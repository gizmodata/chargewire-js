// Licensed under the Apache License, Version 2.0.
//
// Partitioned results (§6.10): the server splits a large result, and the client reads
// every partition at once and merges them. A server without the capability must never
// see the request headers, and still returns everything.

import { describe, expect, test } from "vitest";

import { ErrorCode, WarpSqlError } from "../../src/index.js";
import { FaultProxy, expectCode, isSubmitOf, numbers, open, scalar, sleep } from "./helpers.js";

const descending = (n: number): number[] => Array.from({ length: n }, (_, i) => n - 1 - i);

describe("partitioned results", () => {
  for (const async of [false, true]) {
    test(`a split result keeps ORDER BY order (async: ${async})`, async () => {
      const conn = await open({ resultPartitions: 4, async });
      const table = await conn.query("SELECT i, i * 2 AS j FROM range(1000000) t(i) ORDER BY i DESC");
      expect(numbers(table, "i")).toEqual(descending(1_000_000));
      const stream = conn.stream("SELECT i FROM range(1000000) t(i)");
      const k = await stream.partitions();
      await stream.close();
      if (conn.capabilities.has("result_partitions")) expect(k).toBeGreaterThan(1);
      else expect(k).toBe(1);
    });
  }

  test("the default asks for 8 partitions, only of a server that offers them", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    expect(await scalar(conn, "SELECT count(*) FROM range(10)")).toBe(10);
    const submit = proxy.requests(isSubmitOf("range(10)"))[0]!;
    if (conn.capabilities.has("result_partitions")) {
      expect(submit.headers["warp-result-partitions"]).toBe("8");
      expect(submit.headers["warp-result-order"]).toBeUndefined(); // preserve is the default
    } else {
      expect(submit.headers["warp-result-partitions"]).toBeUndefined();
      expect(submit.headers["warp-result-order"]).toBeUndefined();
    }
  });

  test("order any: every row exactly once", async () => {
    const conn = await open({ resultPartitions: 8, resultOrder: "any" });
    const values = numbers(await conn.query("SELECT i FROM range(2000000) t(i)"), "i").sort((a, b) => a - b);
    expect(values.length).toBe(2_000_000);
    expect(values.every((v, i) => v === i)).toBe(true);
  });

  test("a split result has the same types and nulls as the whole one", async () => {
    const sql =
      "SELECT i, CASE WHEN i % 7 = 0 THEN NULL ELSE i::INTEGER END AS n, " +
      "CASE WHEN i % 5 = 0 THEN NULL ELSE 'row ' || i END AS s, (i % 1000)::DECIMAL(18, 3) AS d, " +
      "TIMESTAMP '2026-01-01' + to_seconds(i) AS ts, [i, NULL] AS l, {'a': i} AS st " +
      "FROM range(400000) t(i) ORDER BY i";
    const whole = await (await open({ resultPartitions: 1 })).query(sql);
    const split = await (await open({ resultPartitions: 5 })).query(sql);
    expect(split.schema.fields.map(String)).toEqual(whole.schema.fields.map(String));
    expect(split.numRows).toBe(whole.numRows);
    for (const name of ["i", "n", "s", "ts"]) {
      expect(Array.from(split.getChild(name)!)).toEqual(Array.from(whole.getChild(name)!));
    }
    expect(
      JSON.stringify(split.slice(399990).toArray(), (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)),
    ).toBe(JSON.stringify(whole.slice(399990).toArray(), (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)));
  });

  test("a split result with empty partitions (two batches split eight ways)", async () => {
    const probe = await (await open({ resultPartitions: 1 })).query("SELECT i FROM range(1000000) t(i)");
    const n = 2 * probe.batches[0]!.numRows;
    const table = await (await open({ resultPartitions: 8 })).query(`SELECT i FROM range(${n}) t(i) ORDER BY i DESC`);
    expect(numbers(table, "i")).toEqual(descending(n));
  });

  test("a failure in any partition fails the whole result with the statement's error", async () => {
    const conn = await open({ resultPartitions: 4 });
    let rows = 0;
    const err = await expectCode(async () => {
      for await (const batch of conn.stream(
        "SELECT CASE WHEN i < 3000000 THEN i ELSE error('boom') END AS v FROM range(10000000) t(i)",
      )) {
        rows += batch.numRows;
      }
    }, ErrorCode.executionError);
    expect(err.message).toContain("boom");
    expect(rows).toBeLessThan(10_000_000);
    // Its positive twin: the same query without the failure reads to the end.
    expect(
      await scalar(
        conn,
        "SELECT count(*) FROM (SELECT CASE WHEN i < 3000000 THEN i ELSE 0 END AS v FROM range(10000000) t(i))",
      ),
    ).toBe(10_000_000);
  });

  test("cancelling a split result stops every partition", async () => {
    const conn = await open({ resultPartitions: 4, resultOrder: "any" });
    const controller = new AbortController();
    const stream = conn.stream("SELECT i, i % 7 AS m FROM range(3000000000) t(i) WHERE i % 3 = 0", undefined, {
      signal: controller.signal,
    });
    const first = await stream.next();
    expect(first.done).toBe(false);
    setTimeout(() => controller.abort(), 200);
    const err = await expectCode(async () => {
      for await (const _ of stream) {
        // keep reading until the cancel lands
      }
    }, ErrorCode.statementCancelled);
    expect(err).toBeInstanceOf(WarpSqlError);
    expect(await scalar(conn, "SELECT 42")).toBe(42);
  });

  test("closing a split result early stops every download, and the connection still works", async () => {
    const conn = await open({ resultPartitions: 4 });
    const stream = conn.stream("SELECT i FROM range(3000000000) t(i)");
    for (let i = 0; i < 3; i++) expect((await stream.next()).done).toBe(false);
    const closed = stream.close();
    expect(await Promise.race([closed.then(() => "closed"), sleep(30_000).then(() => "stuck")])).toBe("closed");
    expect(await scalar(conn, "SELECT 42")).toBe(42);
  });

  test("partition options are checked before anything is sent", async () => {
    const conn = await open();
    await expectCode(conn.query("SELECT 1", undefined, { resultPartitions: 0 }), ErrorCode.clientInvalidArgument);
    await expectCode(conn.query("SELECT 1", undefined, { resultPartitions: 257 }), ErrorCode.clientInvalidArgument);
    await expectCode(
      conn.query("SELECT 1", undefined, { resultOrder: "sorted" as "any" }),
      ErrorCode.clientInvalidArgument,
    );
    expect((await conn.query("SELECT 1", undefined, { resultPartitions: 6, resultOrder: "any" })).numRows).toBe(1);
  });
});

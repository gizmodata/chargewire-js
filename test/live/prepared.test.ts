// Licensed under the Apache License, Version 2.0.

import { Int64, Table, Type, Utf8, tableFromArrays, vectorFromArray } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ErrorCode } from "../../src/index.js";
import { rawDelete } from "./harness.js";
import { FaultProxy, expectCode, numbers, open, scalar, shared } from "./helpers.js";

describe("prepared statements", () => {
  test("preparing describes parameters and result without running the statement", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE p_desc (id INTEGER, name VARCHAR)");
    const insert = await conn.prepare("INSERT INTO p_desc VALUES (?, ?)");
    expect(insert.parameterSchema?.fields.length).toBe(2);
    expect(insert.resultKind).toBe("update");
    expect(await scalar(conn, "SELECT count(*) FROM p_desc")).toBe(0); // preparing ran nothing
    const select = await conn.prepare("SELECT id, name FROM p_desc WHERE id = ?");
    expect(select.resultKind).toBe("rows");
    expect(select.resultSchema?.fields.map((f) => f.name)).toEqual(["id", "name"]);
    await insert.close();
    await select.close();
  });

  test("JSON parameters per execution, reusing one prepared statement", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    const add = await conn.prepare("SELECT ?::INTEGER + 1 AS x");
    for (const v of [1, 41, 99]) {
      expect(numbers(await add.query([v]))).toEqual([v + 1]);
    }
    expect(proxy.requests((r) => r.method === "POST" && r.path.endsWith("/prepared")).length).toBe(1);
    expect(proxy.requests((r) => r.path.endsWith(`/prepared/${add.id}/execute`)).length).toBe(3);
  });

  test("executeBatch: one Arrow row per execution, in one request, in the server's parameter types", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    await conn.execute("CREATE OR REPLACE TABLE p_batch (id BIGINT, name VARCHAR, ts TIMESTAMP)");
    const insert = await conn.prepare("INSERT INTO p_batch VALUES (?, ?, ?)");
    const at = new Date("2026-10-17T12:00:00Z");
    expect(
      await insert.executeBatch([
        [1n, "alice", at],
        [2n, "bob", at],
        [9007199254740993n, null, null],
      ]),
    ).toBe(3);
    const executes = proxy.requests((r) => r.path.endsWith("/execute"));
    expect(executes.length).toBe(1);
    expect(executes[0]!.headers["content-type"]).toBe("application/vnd.apache.arrow.stream");
    const table = await conn.query("SELECT id, name, epoch_ms(ts) AS ms FROM p_batch ORDER BY id");
    expect(table.getChild("id")!.toArray()).toEqual(new BigInt64Array([1n, 2n, 9007199254740993n]));
    expect(table.get(2)!.name).toBeNull();
    expect(Number(table.get(0)!.ms)).toBe(at.getTime());
  });

  test("executeBatch refuses an integer its parameter's type can't hold, instead of wrapping it", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE p_wrap (id BIGINT)");
    const insert = await conn.prepare("INSERT INTO p_wrap VALUES (?)");
    const err = await expectCode(insert.executeBatch([[1n], [2n ** 63n]]), ErrorCode.invalidArgument);
    expect(err.message).toContain("out of range for Int64");
    expect(await scalar(conn, "SELECT count(*) FROM p_wrap")).toBe(0); // nothing was sent
    // The twin: the largest BIGINT, and a plain Number, go in exactly.
    expect(await insert.executeBatch([[2n ** 63n - 1n], [-(2n ** 63n)], [42]])).toBe(3);
    const ids = (await conn.query("SELECT id FROM p_wrap ORDER BY id")).getChild("id")!.toArray();
    expect(ids).toEqual(BigInt64Array.from([-(2n ** 63n), 42n, 2n ** 63n - 1n]));
  });

  test("several parameter rows of a query concatenate their results, in order", async () => {
    const conn = await open();
    const times = await conn.prepare("SELECT ?::INTEGER * 10 AS v FROM range(2)");
    const params = tableFromArrays({ p: Int32Array.from([1, 2, 3]) });
    expect(numbers(await times.query(params))).toEqual([10, 10, 20, 20, 30, 30]);
  });

  test("Arrow parameters on conn.query and conn.execute prepare behind the scenes", async () => {
    const conn = await open();
    const params = new Table({ a: vectorFromArray([5n], new Int64()), b: vectorFromArray(["x"], new Utf8()) });
    const table = await conn.query("SELECT ? + 1 AS a, ? || 'y' AS b", params);
    expect(table.get(0)!.toJSON()).toMatchObject({ a: 6n, b: "xy" });
    await conn.execute("CREATE OR REPLACE TABLE p_exec (v BIGINT)");
    expect(
      await conn.execute("INSERT INTO p_exec VALUES (?)", tableFromArrays({ v: BigInt64Array.from([1n, 2n]) })),
    ).toBe(2);
  });

  test("an Arrow parameter row count of zero returns no rows, not a count", async () => {
    const conn = await open();
    const q = await conn.prepare("SELECT ?::INTEGER AS v");
    const empty = tableFromArrays({ v: Int32Array.from([]) });
    const table = await q.query(empty);
    expect(table.numRows).toBe(0);
    expect(table.schema.fields[0]?.typeId).toBe(Type.Int);
  });

  test("a closed prepared statement refuses to run; an open one runs", async () => {
    const conn = await open();
    const q = await conn.prepare("SELECT 1 AS one");
    expect((await q.query()).numRows).toBe(1);
    await q.close();
    await expectCode(q.query(), ErrorCode.invalidArgument);
  });

  test("a prepared statement the server forgot is prepared again", async () => {
    const conn = await open();
    const q = await conn.prepare("SELECT ?::INTEGER AS v");
    expect(numbers(await q.query([2]))).toEqual([2]);
    await rawDelete(shared, `/v1/sessions/${conn.sessionId}/prepared/${q.id}`); // behind the client's back
    const before = q.id;
    expect(numbers(await q.query([3]))).toEqual([3]);
    expect(q.id).not.toBe(before);
  });

  test("bad SQL fails at prepare time with the server's error", async () => {
    const conn = await open();
    await expectCode(conn.prepare("SELEC ?"), ErrorCode.sqlError);
    expect((await conn.prepare("SELECT ?")).id).toBeTruthy();
  });
});

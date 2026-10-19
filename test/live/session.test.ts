// Licensed under the Apache License, Version 2.0.

import { describe, expect, test } from "vitest";

import { ErrorCode } from "../../src/index.js";
import { expectCode, open, scalar, within } from "./helpers.js";

describe("transactions (§5.5)", () => {
  test("transaction() commits when the work resolves", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE tx_commit (v INTEGER)");
    const result = await conn.transaction(async (tx) => {
      await tx.execute("INSERT INTO tx_commit VALUES (1), (2)");
      return "done";
    });
    expect(result).toBe("done");
    expect(await scalar(await open(), "SELECT count(*) FROM tx_commit")).toBe(2);
  });

  test("transaction() rolls back when the work throws, and autocommit is back on", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE tx_rollback (v INTEGER)");
    await expect(
      conn.transaction(async (tx) => {
        await tx.execute("INSERT INTO tx_rollback VALUES (1)");
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    expect(await scalar(conn, "SELECT count(*) FROM tx_rollback")).toBe(0);
    expect((await conn.getSession()).options?.["autocommit"]).toBe(true);
  });

  test("commit and rollback by hand; other sessions see only committed work", async () => {
    const conn = await open();
    const other = await open();
    await conn.execute("CREATE OR REPLACE TABLE tx_hand (v INTEGER)");
    await conn.setAutocommit(false);
    await conn.execute("INSERT INTO tx_hand VALUES (1)");
    expect(await scalar(other, "SELECT count(*) FROM tx_hand")).toBe(0);
    await conn.commit();
    expect(await scalar(other, "SELECT count(*) FROM tx_hand")).toBe(1);
    await conn.execute("INSERT INTO tx_hand VALUES (2)");
    await conn.rollback();
    expect(await scalar(other, "SELECT count(*) FROM tx_hand")).toBe(1);
    await conn.setAutocommit(true);
  });
});

describe("the session's transaction (§5.2)", () => {
  test("follows SQL BEGIN, an aborting failure and ROLLBACK", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE tx_state (v INTEGER PRIMARY KEY)");
    expect(await conn.transactionState()).toBe("none");
    await conn.execute("BEGIN");
    expect(await conn.transactionState()).toBe("open");
    await expect(conn.execute("INSERT INTO tx_state VALUES (1), (1)")).rejects.toThrow();
    expect(await conn.transactionState()).toBe("aborted");
    await conn.execute("ROLLBACK");
    expect(await conn.transactionState()).toBe("none");
  });

  test("is open while autocommit is off, and none after it is back on", async () => {
    const conn = await open();
    await conn.setAutocommit(false);
    expect((await conn.getSession()).transaction).toBe("open");
    await conn.commit();
    expect(await conn.transactionState()).toBe("open");
    await conn.setAutocommit(true);
    expect(await conn.transactionState()).toBe("none");
  });

  test("a streamed statement's effect shows once its result is read", async () => {
    const conn = await open({ resultPartitions: 1 });
    const table = await conn.query("BEGIN");
    expect(table.numRows).toBe(0);
    expect(await conn.transactionState()).toBe("open");
    await conn.query("COMMIT");
    expect(await conn.transactionState()).toBe("none");
  });
});

describe("one session, several results", () => {
  test("a stream left unread does not block the next statement: it is read ahead into memory", async () => {
    const conn = await open({ resultPartitions: 1 });
    const stream = conn.stream("SELECT i FROM range(300000) t(i)");
    expect((await stream.next()).done).toBe(false); // started, mostly unread
    const answer = await within(scalar(conn, "SELECT 42"), 15_000);
    expect(answer).toBe(42);
    let rows = 0;
    for await (const batch of stream) rows += batch.numRows;
    expect(rows).toBeGreaterThan(0);
    expect(rows + 0).toBeLessThanOrEqual(300000);
  });

  test("the whole stream survives being read ahead, in order", async () => {
    const conn = await open({ resultPartitions: 1 });
    const stream = conn.stream("SELECT i FROM range(300000) t(i)");
    const first = await stream.next();
    await scalar(conn, "SELECT 1");
    const values: number[] = Array.from(first.value!.getChildAt(0)!, Number);
    for await (const batch of stream) for (const v of batch.getChildAt(0)!) values.push(Number(v));
    expect(values.length).toBe(300000);
    expect(values.every((v, i) => v === i)).toBe(true);
  });

  test("a stream too big to hold is dropped, and reading on says so", async () => {
    const conn = await open({ resultPartitions: 1, resultBufferBytes: 1 << 20 });
    const stream = conn.stream("SELECT i FROM range(10000000) t(i)");
    expect((await stream.next()).done).toBe(false);
    expect(await scalar(conn, "SELECT 42")).toBe(42);
    await expectCode(async () => {
      for await (const _ of stream) {
        // the buffered part, then the error
      }
    }, ErrorCode.resultBufferExceeded);
    // Its positive twin: read first, then run the next statement, and nothing is dropped.
    let rows = 0;
    for await (const batch of conn.stream("SELECT i FROM range(3000000) t(i)")) rows += batch.numRows;
    expect(rows).toBe(3_000_000);
  });

  test("concurrent queries on one connection all complete", async () => {
    const conn = await open();
    const results = await Promise.all([1, 2, 3, 4].map((i) => scalar(conn, `SELECT ${i} * 10`)));
    expect(results).toEqual([10, 20, 30, 40]);
  });
});

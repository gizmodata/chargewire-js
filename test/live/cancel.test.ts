// Licensed under the Apache License, Version 2.0.
//
// Cancellation. The oracle is the session itself: a session runs one statement at a time,
// so a statement the server did not stop holds up the next one (see the first test).

import { describe, expect, test } from "vitest";

import { ErrorCode, ChargewireError } from "../../src/index.js";
import {
  FaultProxy,
  expectCode,
  expectSessionUsable,
  isSubmitOf,
  longQuery,
  open,
  scalar,
  sleep,
  streamingQuery,
  within,
} from "./helpers.js";

const settle = (promise: Promise<unknown>): Promise<unknown> => promise.catch((err: unknown) => err);

const isSessionCancel = (r: { method: string; path: string }): boolean =>
  r.method === "POST" && r.path.endsWith("/cancel") && !r.path.includes("/statements/");

describe("cancel", () => {
  test("the oracle works: while a statement runs, the session answers nothing else", async () => {
    const conn = await open();
    const controller = new AbortController();
    const long = settle(conn.query(longQuery, undefined, { signal: controller.signal }));
    await sleep(1000);
    const blocked = scalar(conn, "SELECT 42");
    expect(await within(blocked, 2000)).toBe("pending");
    controller.abort();
    const err = await long;
    expect(ChargewireError.is(err, ErrorCode.statementCancelled)).toBe(true);
    expect(await within(blocked, 30_000)).toBe(42);
  });

  test("an AbortSignal stops a running query on the server", async () => {
    const conn = await open();
    const controller = new AbortController();
    const started = Date.now();
    const running = conn.query(longQuery, undefined, { signal: controller.signal });
    await sleep(1000);
    controller.abort();
    const err = await expectCode(running, ErrorCode.statementCancelled);
    expect(err.cancelReason).toBe("client");
    expect(Date.now() - started).toBeLessThan(20_000);
    await expectSessionUsable(conn);
  });

  test("a statement whose answer has not arrived is cancelled through the session (§6.8), sent once", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    await conn.execute("DROP TABLE IF EXISTS cancelled_update");
    const controller = new AbortController();
    const running = conn.execute(`CREATE OR REPLACE TABLE cancelled_update AS ${longQuery}`, undefined, {
      signal: controller.signal,
    });
    await sleep(1500); // the server holds the answer (Prefer: wait), so no statement id yet
    controller.abort();
    await expectCode(running, ErrorCode.statementCancelled);
    expect(proxy.requests(isSessionCancel).length).toBe(1);
    expect(proxy.requests(isSubmitOf("AS SELECT")).length).toBe(1); // no resend of the CTAS
    await expectSessionUsable(conn);
    expect(await scalar(conn, "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'cancelled_update'")).toBe(0);
  });

  test("beside another statement, only the cancelled one stops: its id is learned by resending with its Idempotency-Key", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    await conn.execute("CREATE OR REPLACE TABLE cancel_bystander (v INTEGER)");
    await conn.execute("DROP TABLE IF EXISTS cancel_target");
    const controller = new AbortController();
    const long = conn.execute(`CREATE OR REPLACE TABLE cancel_target AS ${longQuery}`, undefined, {
      signal: controller.signal,
    });
    await sleep(1000);
    const bystander = conn.execute("INSERT INTO cancel_bystander VALUES (1)"); // waits behind the long statement
    await sleep(500);
    controller.abort();
    await expectCode(long, ErrorCode.statementCancelled);
    expect(await within(bystander, 30_000)).toBe(1);
    expect(proxy.requests(isSessionCancel).length).toBe(0);
    const sameKey = proxy.requests(isSubmitOf("cancel_target AS"));
    expect(sameKey.length).toBe(2);
    expect(sameKey[1]!.headers["idempotency-key"]).toBe(sameKey[0]!.headers["idempotency-key"]);
    expect(sameKey[1]!.headers["prefer"]).toBe("respond-async"); // the recall, not a second run
    expect(await scalar(conn, "SELECT count(*) FROM cancel_bystander")).toBe(1);
  });

  test("an async query is cancelled too", async () => {
    const conn = await open({ async: true });
    const controller = new AbortController();
    const running = conn.query(longQuery, undefined, { signal: controller.signal });
    await sleep(1000);
    controller.abort();
    await expectCode(running, ErrorCode.statementCancelled);
    await expectSessionUsable(conn);
  });

  test("breaking out of a stream stops the query on the server", async () => {
    const conn = await open();
    let batches = 0;
    for await (const batch of conn.stream(streamingQuery)) {
      expect(batch.numRows).toBeGreaterThan(0);
      if (++batches === 2) break;
    }
    expect(batches).toBe(2);
    await expectSessionUsable(conn);
  });

  test("closing a stream while its query runs stops it on the server", async () => {
    const conn = await open();
    const stream = conn.stream(streamingQuery);
    await stream.schema();
    await sleep(1000);
    await stream.close();
    const after = await stream.next();
    expect(after.done).toBe(true);
    await expectSessionUsable(conn);
  });

  test("a stream left unread and never iterated is released by closing the connection", async () => {
    const conn = await open();
    const stream = conn.stream(streamingQuery);
    await stream.schema();
    await conn.close();
    const other = await open();
    expect(await scalar(other, "SELECT 1")).toBe(1);
  });

  test("AbortSignal.timeout reports statement_timeout and stops the statement", async () => {
    const conn = await open();
    const err = await expectCode(
      conn.execute(longQuery, undefined, { signal: AbortSignal.timeout(2000) }),
      ErrorCode.statementTimeout,
    );
    expect((err.cause as Error).name).toBe("TimeoutError");
    await expectSessionUsable(conn);
  });

  test("the server cancels a statement that outlives statementTimeoutMs (§6.9)", async () => {
    const conn = await open();
    for (const async of [false, true]) {
      const e1 = await expectCode(
        conn.execute(longQuery, undefined, { statementTimeoutMs: 500, async }),
        ErrorCode.statementTimeout,
      );
      expect(e1.cancelReason).toBe("timeout");
      await expectCode(
        conn.query(longQuery, undefined, { statementTimeoutMs: 500, async }),
        ErrorCode.statementTimeout,
      );
    }
    // Its positive twin: a quick statement under the same timeout finishes.
    expect(await scalar(conn, "SELECT 1")).toBe(1);
    expect((await conn.query("SELECT 2 AS v", undefined, { statementTimeoutMs: 5000 })).numRows).toBe(1);
    await expectSessionUsable(conn);
  });

  test("an already-aborted signal sends nothing; a live one runs", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    const before = proxy.seen.length;
    await expectCode(conn.query("SELECT 1", undefined, { signal: AbortSignal.abort() }), ErrorCode.statementCancelled);
    expect(proxy.seen.length).toBe(before);
    expect((await conn.query("SELECT 1", undefined, { signal: new AbortController().signal })).numRows).toBe(1);
  });

  test("aborting after the result was read changes nothing", async () => {
    const conn = await open();
    const controller = new AbortController();
    const table = await conn.query("SELECT * FROM range(1000)", undefined, { signal: controller.signal });
    controller.abort();
    expect(table.numRows).toBe(1000);
    await expectSessionUsable(conn);
  });
});

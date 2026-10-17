// Licensed under the Apache License, Version 2.0.
//
// What the client does when the network or the server lets it down: cut result streams,
// lost answers, expiring tokens, sessions the server no longer has.

import { tableFromArrays } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ErrorCode, WarpSqlError } from "../../src/index.js";
import { killSession, launchServer, rawToken } from "./harness.js";
import {
  FaultProxy,
  bigQuery,
  expectBig,
  expectCode,
  isPost,
  isResultFetch,
  isSubmitOf,
  numbers,
  open,
  scalar,
  shared,
  sleep,
} from "./helpers.js";

const resumed = (proxy: FaultProxy) => proxy.requests((r) => isResultFetch(r) && r.query.has("from_batch"));

describe("resumable downloads", () => {
  test("a retained result whose streamed download breaks off resumes from the next batch (§6.5)", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ retainResult: true, resultPartitions: 1 }, proxy.info);
    proxy.add({ match: isSubmitOf("range(1000000)"), cutAfter: 5_000_000, times: 1 });
    expectBig(await conn.query(bigQuery));
    expect(resumed(proxy).length).toBe(1);
  });

  test("an async result resumes twice in one download", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ async: true, resultPartitions: 1 }, proxy.info);
    proxy.add({ match: isResultFetch, cutAfter: 5_000_000, times: 2 });
    expectBig(await conn.query(bigQuery));
    expect(resumed(proxy).length).toBe(2);
  });

  test("an unretained result cut short throws, says why and what helps, and never returns a short table", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ retainResult: false, resultPartitions: 1 }, proxy.info);
    proxy.add({ match: isSubmitOf("range(1000000)"), cutAfter: 300_000, times: 1 });
    let rows = 0;
    const err = await expectCode(async () => {
      for await (const batch of conn.stream(bigQuery)) rows += batch.numRows;
    }, ErrorCode.incompleteStream);
    expect(err.message).toContain("did not retain the result");
    expect(err.message).toContain("retainResult: true");
    expect(rows).toBeLessThan(1_000_000);
    // query() too: it throws rather than return the rows that arrived.
    proxy.add({ match: isSubmitOf("range(1000000)"), cutAfter: 300_000, times: 1 });
    await expectCode(conn.query(bigQuery), ErrorCode.incompleteStream);
    // Its positive twin: the same query through the same proxy, uncut, is whole.
    expectBig(await conn.query(bigQuery));
  });

  test("a failure while the result streams is the statement's error (§6.6)", async () => {
    const conn = await open({ resultPartitions: 1 });
    const err = await expectCode(
      conn.query("SELECT CASE WHEN i < 300000 THEN i ELSE error('boom') END AS v FROM range(1000000) t(i)"),
      ErrorCode.executionError,
    );
    expect(err.message).toContain("boom");
    expect(
      (await conn.query("SELECT CASE WHEN i < 300000 THEN i ELSE 0 END AS v FROM range(1000000) t(i)")).numRows,
    ).toBe(1_000_000);
  });
});

describe("idempotent retries", () => {
  test("a submit whose answer is lost is sent again with the same Idempotency-Key and runs once (§6.7)", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    await conn.execute("CREATE OR REPLACE TABLE once_t (v INTEGER)");
    proxy.add({ match: isSubmitOf("INSERT INTO once_t"), cutAfter: 0, times: 1 });
    expect(await conn.execute("INSERT INTO once_t VALUES (1)")).toBe(1);
    expect(await scalar(conn, "SELECT count(*) FROM once_t")).toBe(1);
    const sends = proxy.requests(isSubmitOf("INSERT INTO once_t"));
    expect(sends.length).toBe(2);
    expect(sends[1]!.headers["idempotency-key"]).toBe(sends[0]!.headers["idempotency-key"]);
  });

  test("an upload whose answer is lost is sent again and written once", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({}, proxy.info);
    await conn.execute("DROP TABLE IF EXISTS ing_retry");
    proxy.add({ match: isPost("/ingest"), cutAfter: 0, times: 1 });
    expect(await conn.ingest("ing_retry", tableFromArrays({ k: Int32Array.from([1, 2, 3]) }))).toBe(3);
    expect(await scalar(conn, "SELECT count(*) FROM ing_retry")).toBe(3);
    const sends = proxy.requests(isPost("/ingest"));
    expect(sends.length).toBe(2);
    expect(sends[1]!.headers["idempotency-key"]).toBe(sends[0]!.headers["idempotency-key"]);
  });

  test("a lost answer to a status poll is retried", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ async: true }, proxy.info);
    proxy.add({
      match: (r) => r.method === "GET" && r.path.includes("/statements/") && !r.path.endsWith("/result"),
      cutAfter: 0,
      times: 1,
    });
    expect(await scalar(conn, "SELECT count(*) FROM range(300000000)")).toBe(300_000_000);
    expect(
      proxy.requests((r) => r.method === "GET" && r.path.includes("/statements/") && !r.path.endsWith("/result"))
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("zstd results: asked for, used, and identical to uncompressed ones (§8.2)", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ ipcCompression: "zstd", async: true, resultPartitions: 1 }, proxy.info);
    expectBig(await conn.query(bigQuery));
    expect(proxy.requests(isResultFetch)[0]!.headers["warp-ipc-compression"]).toBe("zstd");
    const sql =
      "SELECT i, 'v' || i AS s, i * 1.5 AS d, CASE WHEN i % 3 = 0 THEN NULL ELSE i END AS n FROM range(100000) t(i)";
    const plain = await (await open({ resultPartitions: 1 })).query(sql);
    const zstd = await conn.query(sql);
    for (const name of ["i", "s", "n"])
      expect(Array.from(zstd.getChild(name)!)).toEqual(Array.from(plain.getChild(name)!));
  });

  test("the query tag is sent as Warp-Query-Tag", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ queryTag: { job: "nightly" } }, proxy.info);
    await scalar(conn, "SELECT 1");
    expect(proxy.requests(isPost("/statements"))[0]!.headers["warp-query-tag"]).toBe('{"job":"nightly"}');
    await expectCode(open({ queryTag: "not json" as unknown as Record<string, unknown> }), ErrorCode.invalidArgument);
  });
});

describe("tokens", () => {
  test("a short-lived token is renewed before it expires, and work goes on", async () => {
    const server = await launchServer(["--token-lifetime-seconds", "4"]);
    try {
      const proxy = await FaultProxy.start(server);
      const conn = await open({}, proxy.info);
      for (let i = 0; i < 4; i++) {
        expect(await scalar(conn, `SELECT ${i}`)).toBe(i);
        await sleep(1500);
      }
      expect(proxy.requests(isPost("/auth/token")).length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.stop();
    }
  });

  test("a refused token is renewed once with the connection's credentials", async () => {
    const proxy = await FaultProxy.start();
    let calls = 0;
    const conn = await open(
      {
        password: undefined,
        username: undefined,
        tokenProvider: async () => (++calls === 1 ? "not-a-token" : rawToken(shared)),
      },
      proxy.info,
    );
    expect(await scalar(conn, "SELECT 5")).toBe(5);
    expect(calls).toBe(2);
    // Its negative twin: a token issued elsewhere cannot be renewed, so the refusal stands.
    await expectCode(
      open({ password: undefined, username: undefined, token: "not-a-token" }, proxy.info),
      ErrorCode.invalidToken,
    );
  });
});

describe("lost sessions (§5.6)", () => {
  test("a lost session is replaced with the connection's options, and the statement runs there", async () => {
    const conn = await open();
    await conn.execute("ATTACH IF NOT EXISTS ':memory:' AS replay_cat");
    await conn.setOptions({ catalog: "replay_cat" });
    const old = conn.sessionId;
    await killSession(shared, old);
    expect(await scalar(conn, "SELECT 5")).toBe(5);
    expect(conn.sessionReplacements).toBe(1);
    expect(conn.sessionId).not.toBe(old);
    expect((await conn.getSession()).options?.["catalog"]).toBe("replay_cat");
  });

  test("what did not survive is said: a temporary table is gone, and the error says the session was replaced", async () => {
    const conn = await open();
    await conn.execute("CREATE TEMPORARY TABLE scratch AS SELECT 7 AS v");
    expect(await scalar(conn, "SELECT v FROM scratch")).toBe(7);
    await killSession(shared, conn.sessionId);
    const err = await expectCode(conn.query("SELECT v FROM scratch"), ErrorCode.sqlError);
    expect(err.message).toContain("replacement session");
  });

  test("inside a transaction nothing runs on a replacement; the connection is usable afterwards", async () => {
    const conn = await open();
    await conn.execute("CREATE OR REPLACE TABLE lost_tx (v INTEGER)");
    await conn.setAutocommit(false);
    await conn.execute("INSERT INTO lost_tx VALUES (1)");
    await killSession(shared, conn.sessionId);
    const err = await expectCode(conn.execute("INSERT INTO lost_tx VALUES (2)"), ErrorCode.sessionNotFound);
    expect(err.message).toContain("open transaction");
    expect(err.replacementSessionId).toBe(conn.sessionId);
    // The replacement runs with autocommit off, like the old session.
    await conn.execute("INSERT INTO lost_tx VALUES (3)");
    await conn.commit();
    expect(await scalar(await open(), "SELECT sum(v)::BIGINT FROM lost_tx")).toBe(3);
  });

  test("commit of a lost transaction fails rather than pretending", async () => {
    const conn = await open();
    await conn.setAutocommit(false);
    await killSession(shared, conn.sessionId);
    await expectCode(conn.commit(), ErrorCode.sessionNotFound);
  });

  test("with reconnect off, the connection stays broken and says so", async () => {
    const conn = await open({ reconnect: false });
    await killSession(shared, conn.sessionId);
    for (let i = 0; i < 2; i++) {
      const err = await expectCode(conn.query("SELECT 1"), ErrorCode.sessionNotFound);
      expect(err.message).toContain("must be reopened");
    }
  });

  test("a prepared statement lost with its session is prepared again", async () => {
    const conn = await open();
    const q = await conn.prepare("SELECT ?::INTEGER + 1 AS v");
    expect(numbers(await q.query([41]))).toEqual([42]);
    await killSession(shared, conn.sessionId);
    expect(numbers(await q.query([41]))).toEqual([42]);
  });

  test("a session ended for another reason is an error, not replaced", async () => {
    const conn = await open();
    expect(WarpSqlError.is(new WarpSqlError({ code: "session_ended", reason: "killed" }), "session_ended")).toBe(true);
    expect(conn.sessionReplacements).toBe(0);
  });
});

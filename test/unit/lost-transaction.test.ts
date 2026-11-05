// Spec §5.7: a client that gets session_not_found can't tell whether a transaction was lost
// with the session, so it must not run a request again on a new session unless it knows no
// transaction was open. The client knows that when autocommit is on and no SQL that can begin
// a transaction ran in the lost session; otherwise the request that finds the loss fails (the
// replacement is open, so the next call works), whatever kind of request it is.

import { describe, expect, test } from "vitest";

import { type Connection, ErrorCode, ChargewireError, connect } from "../../src/index.js";
import { mayOpenTransaction } from "../../src/session.js";
import { FakeServer, json, problem } from "./fake.js";

const quiet = { warn: () => {} };
const open = (server: FakeServer, extra: Record<string, unknown> = {}): Promise<Connection> =>
  connect({
    url: "chargewire://db.test:31337",
    username: "joe",
    password: "pw",
    fetch: server.fetch,
    logger: quiet,
    ...extra,
  });

const done = (rows: number) =>
  json(200, { statement_id: "q", state: "succeeded", result: { kind: "update", rows_affected: rows } });

async function expectCode(work: Promise<unknown>, code: string): Promise<ChargewireError> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChargewireError);
  expect((err as ChargewireError).code, String(err)).toBe(code);
  return err as ChargewireError;
}

/** Session s1 answers its first `alive` statements, then is gone; s2 runs everything. */
function losesSession(server: FakeServer, alive: number): { ranOnS2: string[] } {
  let calls = 0;
  const ranOnS2: string[] = [];
  server.on("POST", /\/sessions\/s1\/statements$/, () =>
    ++calls <= alive ? done(0) : problem(404, "session_not_found"),
  );
  server.on("POST", /\/sessions\/s2\/statements$/, (req) => {
    ranOnS2.push((JSON.parse(req.body) as { sql: string }).sql);
    return done(1);
  });
  return { ranOnS2 };
}

describe("session_not_found and a transaction the client can't see (§5.7)", () => {
  test("after SQL BEGIN, the next statement fails on the replacement instead of running alone", async () => {
    const server = new FakeServer();
    const { ranOnS2 } = losesSession(server, 2);
    const conn = await open(server);
    await conn.execute("BEGIN");
    await conn.execute("INSERT INTO t VALUES (1)");
    const err = await expectCode(conn.execute("INSERT INTO t VALUES (2)"), ErrorCode.sessionNotFound);
    expect(err.lostSessionId).toBe("s1");
    expect(err.replacementSessionId).toBe("s2");
    expect(err.message).toContain("a transaction may have been open there");
    expect(ranOnS2).toEqual([]); // never run again in autocommit
    // The connection works again on the replacement.
    expect(await conn.execute("INSERT INTO t VALUES (3)")).toBe(1);
    expect(ranOnS2).toEqual(["INSERT INTO t VALUES (3)"]);
  });

  test("its twin: with only SQL that can't begin a transaction, the statement runs again on the replacement", async () => {
    const server = new FakeServer();
    const { ranOnS2 } = losesSession(server, 2);
    const conn = await open(server);
    await conn.execute("CREATE TABLE t (begin_date DATE)"); // begin_date is not BEGIN
    await conn.execute("INSERT INTO t VALUES ('2026-11-05')");
    expect(await conn.execute("SELECT 1")).toBe(1);
    expect(ranOnS2).toEqual(["SELECT 1"]);
    expect(conn.sessionReplacements).toBe(1);
  });

  test("a query (the streamed path) is not run again either", async () => {
    const server = new FakeServer();
    const { ranOnS2 } = losesSession(server, 1);
    const conn = await open(server);
    await conn.execute("START TRANSACTION");
    await expectCode(conn.query("SELECT 1"), ErrorCode.sessionNotFound);
    expect(ranOnS2).toEqual([]);
  });

  test("the transaction's mark stays with the lost session: the replacement starts clean", async () => {
    const server = new FakeServer();
    losesSession(server, 1);
    let s2Calls = 0;
    server.on("POST", /\/sessions\/s2\/statements$/, () =>
      ++s2Calls === 1 ? done(1) : problem(404, "session_not_found"),
    );
    server.on("POST", /\/sessions\/s3\/statements$/, () => done(7));
    const conn = await open(server);
    await conn.execute("BEGIN");
    await expectCode(conn.execute("INSERT INTO t VALUES (1)"), ErrorCode.sessionNotFound);
    expect(await conn.execute("INSERT INTO t VALUES (2)")).toBe(1); // on s2, no BEGIN there
    expect(await conn.execute("INSERT INTO t VALUES (3)")).toBe(7); // s2 lost: run again on s3
  });

  test("a session request that finds the loss fails too, instead of hiding it", async () => {
    const server = new FakeServer();
    losesSession(server, 1);
    server.on("GET", /\/sessions\/s1\/metadata\/server-info$/, () => problem(404, "session_not_found"));
    server.on("GET", /\/sessions\/s2\/metadata\/server-info$/, () => json(200, { server_name: "fake" }));
    const conn = await open(server);
    await conn.execute("BEGIN");
    const err = await expectCode(conn.metadata.serverInfo(), ErrorCode.sessionNotFound);
    expect(err.replacementSessionId).toBe("s2");
    expect(await conn.metadata.serverInfo()).toEqual({ server_name: "fake" });
  });

  test("with autocommit off, a session request that finds the loss fails", async () => {
    const server = new FakeServer();
    server.on("PATCH", /\/sessions\/s1$/, () => json(200, { options: { autocommit: false }, errors: {} }));
    server.on("GET", /\/sessions\/s1\/metadata\/server-info$/, () => problem(404, "session_not_found"));
    server.on("GET", /\/sessions\/s2\/metadata\/server-info$/, () => json(200, { server_name: "fake" }));
    const conn = await open(server);
    await conn.setAutocommit(false);
    const err = await expectCode(conn.metadata.serverInfo(), ErrorCode.sessionNotFound);
    expect(err.message).toContain("open transaction");
    expect(await conn.metadata.serverInfo()).toEqual({ server_name: "fake" });
  });

  test("session_ended idle_in_transaction found by a session request fails it too", async () => {
    const server = new FakeServer();
    server.on("GET", /^\/chargewire\/v1\/sessions\/s1$/, () =>
      problem(401, "session_ended", { reason: "idle_in_transaction" }),
    );
    server.on("GET", /^\/chargewire\/v1\/sessions\/s2$/, () =>
      json(200, { session_id: "s2", options: {}, transaction: "none" }),
    );
    const conn = await open(server);
    const err = await expectCode(conn.transactionState(), ErrorCode.sessionEnded);
    expect(err.reason).toBe("idle_in_transaction");
    expect(err.replacementSessionId).toBe("s2");
    expect(server.tokens).toBe(1);
    expect(await conn.transactionState()).toBe("none");
  });

  test("a prepared statement is not prepared again and run after SQL BEGIN ran in the lost session", async () => {
    const server = new FakeServer();
    losesSession(server, 1);
    let prepares = 0;
    server.on("POST", /\/prepared$/, () => json(201, { prepared_id: `p${++prepares}`, parameter_schema: null }));
    server.on("POST", /\/sessions\/s1\/prepared\/p1\/execute$/, () => problem(404, "session_not_found"));
    let ranOnS2 = 0;
    server.on("POST", /\/sessions\/s2\/prepared\/p2\/execute$/, () => {
      ranOnS2++;
      return done(1);
    });
    const conn = await open(server);
    const q = await conn.prepare("INSERT INTO t VALUES (?)");
    await conn.execute("BEGIN");
    const err = await expectCode(q.execute([1]), ErrorCode.sessionNotFound);
    expect(err.message).toContain("a transaction may have been open there");
    expect(ranOnS2).toBe(0);
    expect(prepares).toBe(1);
    // The next run prepares it in the replacement.
    expect(await q.execute([2])).toBe(1);
    expect(ranOnS2).toBe(1);
  });

  test("its twin: without BEGIN, a prepared statement lost with its session is prepared again and run", async () => {
    const server = new FakeServer();
    let prepares = 0;
    server.on("POST", /\/prepared$/, () => json(201, { prepared_id: `p${++prepares}`, parameter_schema: null }));
    server.on("POST", /\/sessions\/s1\/prepared\/p1\/execute$/, () => problem(404, "session_not_found"));
    server.on("POST", /\/sessions\/s2\/prepared\/p2\/execute$/, () => done(1));
    const conn = await open(server);
    const q = await conn.prepare("INSERT INTO t VALUES (?)");
    expect(await q.execute([1])).toBe(1);
    expect(prepares).toBe(2);
  });

  test("which SQL may begin a transaction: a word search that errs only toward suspecting one", () => {
    for (const sql of [
      "BEGIN",
      "begin transaction",
      "START TRANSACTION",
      "start\n  transaction",
      "SELECT 1; BEGIN",
      "/* begin */ SELECT 1",
      "SELECT 'BEGIN'",
      "SET autocommit = false",
    ]) {
      expect(mayOpenTransaction(sql), sql).toBe(true);
    }
    for (const sql of ["SELECT 1", "SELECT begin_date FROM t", "INSERT INTO beginnings VALUES (1)", "SELECT started"]) {
      expect(mayOpenTransaction(sql), sql).toBe(false);
    }
  });
});

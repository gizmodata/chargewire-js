import { tableFromArrays } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { type Connection, ErrorCode, WarpSqlError, connect } from "../../src/index.js";
import { FakeServer, arrow, json, problem } from "./fake.js";

const quiet = { warn: () => {} };
const open = (server: FakeServer, extra: Record<string, unknown> = {}): Promise<Connection> =>
  connect({
    url: "warp://db.test:31337",
    username: "joe",
    password: "p:w@d",
    fetch: server.fetch,
    logger: quiet,
    ...extra,
  });

const doneDoc = (id: string, result: unknown) => ({ statement_id: id, state: "succeeded", result });

async function expectCode(work: Promise<unknown>, code: string): Promise<WarpSqlError> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WarpSqlError);
  expect((err as WarpSqlError).code, String(err)).toBe(code);
  return err as WarpSqlError;
}

describe("connecting", () => {
  test("the password travels in a JSON body, never in the URL", async () => {
    const server = new FakeServer();
    await open(server);
    const tokenRequest = server.requests.find((r) => r.url.pathname.endsWith("/auth/token"))!;
    expect(JSON.parse(tokenRequest.body)).toEqual({ grant_type: "password", username: "joe", password: "p:w@d" });
    expect(server.requests.every((r) => !r.url.href.includes("p:w@d"))).toBe(true);
  });

  test("a server that does not speak version 1 is refused", async () => {
    const server = new FakeServer();
    server.on("GET", /^\/warp$/, () => json(200, { protocol: "warp-sql", protocol_versions: ["2"] }));
    await expectCode(open(server), ErrorCode.protocolError);
  });
});

describe("tokens (§4)", () => {
  test("a token is renewed before it expires", async () => {
    const server = new FakeServer();
    server.expiresIn = 1;
    server.on("POST", /\/statements$/, () => json(200, doneDoc("q1", { kind: "update", rows_affected: 1 })));
    const conn = await open(server);
    expect(server.tokens).toBe(1);
    await new Promise((r) => setTimeout(r, 800)); // past three quarters of its life
    expect(await conn.execute("DELETE FROM t")).toBe(1);
    expect(server.tokens).toBe(2);
  });

  test("a refused token is renewed once; a second refusal is the error", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => json(200, doneDoc("q1", { kind: "update", rows_affected: 1 })));
    const conn = await open(server);
    server.validTokens.clear(); // the server forgot every token
    expect(await conn.execute("DELETE FROM t")).toBe(1);
    expect(server.tokens).toBe(2);
    server.on("POST", /\/statements$/, () => problem(401, "invalid_token"));
    await expectCode(conn.execute("DELETE FROM t"), ErrorCode.invalidToken);
    expect(server.tokens).toBe(3); // renewed once more, then gave up
  });
});

describe("sessions (§5.6)", () => {
  test("session_ended for an expired token: a new token, then a replacement session, and the statement runs", async () => {
    const server = new FakeServer();
    let ended = false;
    server.on("POST", /\/sessions\/s1\/statements$/, () => {
      ended = true;
      return problem(401, "session_ended", { reason: "token_expired" });
    });
    server.on("POST", /\/sessions\/s2\/statements$/, () =>
      json(200, doneDoc("q2", { kind: "update", rows_affected: 5 })),
    );
    const conn = await open(server);
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(5);
    expect(ended).toBe(true);
    expect(server.tokens).toBe(2);
    expect(conn.sessionId).toBe("s2");
    expect(conn.sessionReplacements).toBe(1);
  });

  test("session_ended for any other reason is an error with its reason, and nothing is replaced", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => problem(401, "session_ended", { reason: "killed" }));
    const conn = await open(server);
    const err = await expectCode(conn.execute("SELECT 1"), ErrorCode.sessionEnded);
    expect(err.reason).toBe("killed");
    expect(conn.sessionReplacements).toBe(0);
  });

  test("two requests that both find the session gone open one replacement", async () => {
    const server = new FakeServer();
    server.on("GET", /\/sessions\/s1\/metadata\/server-info$/, () => problem(404, "session_not_found"));
    server.on("GET", /\/sessions\/s2\/metadata\/server-info$/, () => json(200, { server_name: "fake" }));
    const conn = await open(server);
    const [a, b] = await Promise.all([conn.metadata.serverInfo(), conn.metadata.serverInfo()]);
    expect(a).toEqual({ server_name: "fake" });
    expect(b).toEqual({ server_name: "fake" });
    expect(server.sessions).toBe(2);
  });
});

describe("retries", () => {
  test("Retry-After is honoured for a request that is safe to repeat", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.on("GET", /\/metadata\/server-info$/, () =>
      ++calls === 1 ? problem(503, "server_draining", {}, { "retry-after": "1" }) : json(200, { server_name: "fake" }),
    );
    const conn = await open(server);
    const started = Date.now();
    expect(await conn.metadata.serverInfo()).toEqual({ server_name: "fake" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(calls).toBe(2);
  });

  test("a commit is never retried: its lost answer may mean it happened", async () => {
    const server = new FakeServer();
    let commits = 0;
    server.on("POST", /\/commit$/, () => {
      commits++;
      return problem(503, "server_draining", {}, { "retry-after": "0" });
    });
    const conn = await open(server);
    await expectCode(conn.commit(), ErrorCode.serverDraining);
    expect(commits).toBe(1);
  });

  test("a submit is retried after a lost answer with the same Idempotency-Key", async () => {
    const server = new FakeServer();
    const keys: string[] = [];
    server.on("POST", /\/statements$/, (req) => {
      keys.push(req.headers.get("idempotency-key")!);
      if (keys.length === 1) throw new TypeError("fetch failed");
      return json(200, doneDoc("q1", { kind: "update", rows_affected: 1 }));
    });
    const conn = await open(server);
    expect(await conn.execute("INSERT INTO t VALUES (1)")).toBe(1);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^k_[0-9a-f]{32}$/);
  });

  test("a misdirected request (421 session_elsewhere) is retried", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.on("GET", /\/sessions\/s1$/, () =>
      ++calls === 1 ? problem(421, "session_elsewhere") : json(200, { session_id: "s1", options: {} }),
    );
    const conn = await open(server);
    expect((await conn.getSession()).session_id).toBe("s1");
    expect(calls).toBe(2);
  });
});

describe("results", () => {
  const rows = (from: number, n: number) => tableFromArrays({ v: Int32Array.from({ length: n }, (_, i) => from + i) });

  test("partitions on other servers are read from their locations with the same token and ids", async () => {
    const server = new FakeServer();
    server.capabilities.push("partitioned_results");
    server.on("POST", /\/statements$/, () =>
      json(
        201,
        doneDoc("q1", {
          kind: "rows",
          partitions: [
            { index: 0, location: null },
            { index: 1, location: "https://worker-2.test:9000/warp" },
          ],
          retained: true,
        }),
      ),
    );
    server.on("GET", /^\/warp\/v1\/sessions\/s1\/statements\/q1\/result$/, (req) =>
      req.url.host === "worker-2.test:9000" && req.url.searchParams.get("partition") === "1"
        ? arrow(rows(100, 3))
        : arrow(rows(0, 3)),
    );
    const conn = await open(server, { async: true });
    const table = await conn.query("SELECT v FROM t");
    expect(Array.from(table.getChild("v")!)).toEqual([0, 1, 2, 100, 101, 102]);
    const remote = server.requests.find((r) => r.url.host === "worker-2.test:9000")!;
    expect(remote.headers.get("authorization")).toBe("Bearer t1");
  });

  test("an interleaved result with a partition that runs long is a protocol error, not wrong rows", async () => {
    const server = new FakeServer();
    server.capabilities.push("result_partitions");
    server.on("POST", /\/statements$/, () =>
      arrow(rows(0, 2), {
        "warp-statement-id": "q1",
        "warp-result-partitions": "2",
        "warp-result-order": "interleaved",
      }),
    );
    server.on("GET", /\/statements\/q1\/result$/, () => {
      const t = tableFromArrays({ v: Int32Array.from([9]) });
      const two = tableFromArrays({ v: Int32Array.from([8]) });
      return arrow(t.concat(two)); // two batches where partition 0 has one
    });
    server.on("GET", /\/statements\/q1$/, () => json(200, doneDoc("q1", { kind: "rows", retained: false })));
    const conn = await open(server);
    await expectCode(conn.query("SELECT v FROM t"), ErrorCode.protocolError);
  });

  test("a stream that ends without its marker throws, even when the statement says it succeeded", async () => {
    const server = new FakeServer();
    const full = (await arrow(rows(0, 1000)).arrayBuffer()) as ArrayBuffer;
    server.on(
      "POST",
      /\/statements$/,
      () =>
        new Response(new Uint8Array(full).slice(0, full.byteLength - 8), {
          headers: { "content-type": "application/vnd.apache.arrow.stream", "warp-statement-id": "q1" },
        }),
    );
    server.on("GET", /\/statements\/q1$/, () => json(200, doneDoc("q1", { kind: "rows", retained: false })));
    const conn = await open(server, { resultPartitions: 1 });
    const err = await expectCode(conn.query("SELECT v FROM t"), ErrorCode.incompleteStream);
    expect(err.message).toContain("cannot be resumed");
    // Its positive twin: the whole stream, marker included, is a table.
    server.on("POST", /\/statements$/, () => arrow(rows(0, 1000), { "warp-statement-id": "q2" }));
    expect((await conn.query("SELECT v FROM t")).numRows).toBe(1000);
  });

  test("a failed statement document is the statement's error, with its id", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () =>
      json(201, {
        statement_id: "q1",
        state: "failed",
        error: { code: "execution_error", detail: "division by zero", sqlstate: "22012" },
      }),
    );
    const conn = await open(server);
    const err = await expectCode(conn.execute("SELECT 1/0"), ErrorCode.executionError);
    expect(err.statementId).toBe("q1");
    expect(err.sqlstate).toBe("22012");
  });
});

describe("capabilities (§3.1)", () => {
  test("a feature the server does not list is not used", async () => {
    const server = new FakeServer();
    server.capabilities = [];
    const conn = await open(server);
    await expectCode(conn.prepare("SELECT ?"), ErrorCode.notImplemented);
    await expectCode(conn.ingest("t", tableFromArrays({ v: Int32Array.from([1]) })), ErrorCode.notImplemented);
    await expectCode(conn.commit(), ErrorCode.notImplemented);
    expect(server.count("POST", /\/prepared$/)).toBe(0);
    expect(server.count("POST", /\/ingest$/)).toBe(0);
  });
});

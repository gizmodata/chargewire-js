import { readFileSync } from "node:fs";

import { tableFromArrays } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { type Connection, ErrorCode, WarpSqlError, connect, version } from "../../src/index.js";
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
    await expectCode(open(server), ErrorCode.clientProtocolError);
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

describe("invalid_token reasons (§4.2)", () => {
  for (const reason of ["token_revoked", "credentials_changed", "principal_dropped"]) {
    test(`after ${reason} the client does not sign in again, and reports the reason`, async () => {
      const server = new FakeServer();
      server.on("POST", /\/statements$/, () =>
        problem(401, "invalid_token", { reason }, { "www-authenticate": "Bearer" }),
      );
      const conn = await open(server);
      const err = await expectCode(conn.execute("DELETE FROM t"), ErrorCode.invalidToken);
      expect(err.reason).toBe(reason);
      expect(server.tokens).toBe(1); // no new sign-in
      expect(server.count("POST", /\/statements$/)).toBe(1);
    });
  }

  for (const reason of [undefined, "token_expired", "some_future_reason"]) {
    test(`after ${reason ?? "no reason"} the client signs in again once`, async () => {
      const server = new FakeServer();
      let calls = 0;
      server.on("POST", /\/statements$/, () =>
        ++calls === 1
          ? problem(401, "invalid_token", reason !== undefined ? { reason } : {})
          : json(200, doneDoc("q1", { kind: "update", rows_affected: 1 })),
      );
      const conn = await open(server);
      expect(await conn.execute("DELETE FROM t")).toBe(1);
      expect(server.tokens).toBe(2);
    });
  }
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

  test("GET of a killed session is session_ended with its reason: no token renewal, no replacement", async () => {
    const server = new FakeServer();
    server.on("GET", /^\/warp\/v1\/sessions\/s1$/, () => problem(401, "session_ended", { reason: "killed" }));
    const conn = await open(server);
    const err = await expectCode(conn.getSession(), ErrorCode.sessionEnded);
    expect(err.reason).toBe("killed");
    expect(server.tokens).toBe(1);
    expect(server.sessions).toBe(1);
    expect(conn.sessionReplacements).toBe(0);
  });

  test("session_ended for any other reason is an error with its reason, and nothing is replaced", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => problem(401, "session_ended", { reason: "killed" }));
    const conn = await open(server);
    const err = await expectCode(conn.execute("SELECT 1"), ErrorCode.sessionEnded);
    expect(err.reason).toBe("killed");
    expect(conn.sessionReplacements).toBe(0);
  });

  for (const reason of ["credentials_changed", "principal_dropped", "token_revoked"]) {
    test(`session_ended for ${reason}: no sign-in, no replacement session; the reason is the error`, async () => {
      const server = new FakeServer();
      server.on("POST", /\/statements$/, () => problem(401, "session_ended", { reason }));
      const conn = await open(server);
      const err = await expectCode(conn.execute("SELECT 1"), ErrorCode.sessionEnded);
      expect(err.reason).toBe(reason);
      expect(server.tokens).toBe(1);
      expect(server.sessions).toBe(1);
      expect(conn.sessionReplacements).toBe(0);
    });
  }

  test("session_ended with a reason the client doesn't know is a generic end: reported, not replaced (§12)", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => problem(401, "session_ended", { reason: "some_future_reason" }));
    const conn = await open(server);
    const err = await expectCode(conn.execute("SELECT 1"), ErrorCode.sessionEnded);
    expect(err.reason).toBe("some_future_reason");
    expect(server.sessions).toBe(1);
  });

  test("session_ended for an expired token with a token the client can't renew: no new session with the old token", async () => {
    const server = new FakeServer();
    server.validTokens.add("static-token");
    server.on("POST", /\/statements$/, () => problem(401, "session_ended", { reason: "token_expired" }));
    const conn = await connect({
      url: "warp://db.test:31337",
      token: "static-token",
      fetch: server.fetch,
      logger: quiet,
    });
    await expectCode(conn.execute("SELECT 1"), ErrorCode.sessionEnded);
    expect(server.sessions).toBe(1);
  });

  test("invalid_token(token_expired) then session_ended(token_expired): one new sign-in, then a replacement", async () => {
    const server = new FakeServer();
    server.on("POST", /\/sessions\/s1\/statements$/, (req) =>
      req.headers.get("authorization") === "Bearer t1"
        ? problem(401, "invalid_token", { reason: "token_expired" })
        : problem(401, "session_ended", { reason: "token_expired" }),
    );
    server.on("POST", /\/sessions\/s2\/statements$/, () =>
      json(200, doneDoc("q2", { kind: "update", rows_affected: 2 })),
    );
    const conn = await open(server);
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(2);
    expect(server.tokens).toBe(2); // the sign-in after invalid_token is the new token §5.6 asks for
    expect(conn.sessionId).toBe("s2");
  });

  test("a transaction value the client doesn't know is reported as unknown (§12)", async () => {
    const server = new FakeServer();
    server.on("GET", /^\/warp\/v1\/sessions\/s1$/, () =>
      json(200, { session_id: "s1", options: {}, transaction: "some_future_state" }),
    );
    const conn = await open(server);
    expect(await conn.transactionState()).toBe("unknown");
    server.on("GET", /^\/warp\/v1\/sessions\/s1$/, () =>
      json(200, { session_id: "s1", options: {}, transaction: "aborted" }),
    );
    expect(await conn.transactionState()).toBe("aborted");
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

  test("close waits for a statement's delete before ending the session", async () => {
    const server = new FakeServer();
    let release: (() => void) | undefined;
    server.on("POST", /\/statements$/, () => json(200, doneDoc("q1", { kind: "update", rows_affected: 1 })));
    server.on("DELETE", /\/statements\/q1$/, async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(null, { status: 204 });
    });
    const conn = await open(server);
    expect(await conn.execute("ROLLBACK")).toBe(1);
    const closing = conn.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(server.count("DELETE", /^\/warp\/v1\/sessions\/[^/]+$/)).toBe(0);
    release!();
    await closing;
    const order = server.requests.filter((r) => r.method === "DELETE").map((r) => r.url.pathname);
    expect(order).toEqual(["/warp/v1/sessions/s1/statements/q1", "/warp/v1/sessions/s1"]);
  });

  test.each(["query", "execute"] as const)(
    "%s finishing after close does not delete a statement from the ended session",
    async (method) => {
      const server = new FakeServer();
      let release!: (response: Response) => void;
      let submitted!: () => void;
      const response = new Promise<Response>((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (submitted = resolve));
      server.on("POST", /\/statements$/, () => {
        submitted();
        return response;
      });
      const conn = await open(server);
      const result = conn[method]("SELECT 42 AS answer");
      await started;
      await conn.close();
      expect(server.count("DELETE", /^\/warp\/v1\/sessions\/[^/]+$/)).toBe(1);
      release(
        method === "query"
          ? arrow(tableFromArrays({ answer: [42] }), { "warp-statement-id": "q1" })
          : json(200, doneDoc("q1", { kind: "update", rows_affected: 1 })),
      );
      await result;
      // Drain cleanup microtasks before checking that none reached the ended session.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.count("DELETE", /\/statements\/q1$/)).toBe(0);
    },
  );

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
      ++calls === 1
        ? problem(421, "session_elsewhere")
        : json(200, { session_id: "s1", options: {}, transaction: "none" }),
    );
    const conn = await open(server);
    expect((await conn.getSession()).session_id).toBe("s1");
    expect(calls).toBe(2);
  });
});

describe("results", () => {
  const rows = (from: number, n: number) => tableFromArrays({ v: Int32Array.from({ length: n }, (_, i) => from + i) });

  test("partitions on other servers are read from their locations with the same token and ids, all at once", async () => {
    const server = new FakeServer();
    server.capabilities.push("result_locations");
    let submit: Headers | undefined;
    server.on("POST", /\/statements$/, (req) => {
      submit = req.headers;
      return json(
        201,
        doneDoc("q1", {
          kind: "rows",
          partitions: [
            { index: 0, location: null },
            { index: 1, location: "https://worker-2.test:9000/warp" },
          ],
          partition_order: "any",
          retained: true,
        }),
      );
    });
    // Partition 0 answers only once partition 1 was asked for: read one after the other, this hangs.
    let remoteAsked: () => void = () => {};
    const remote = new Promise<void>((resolve) => (remoteAsked = resolve));
    server.on("GET", /^\/warp\/v1\/sessions\/s1\/statements\/q1\/result$/, async (req) => {
      if (req.url.host === "worker-2.test:9000" && req.url.searchParams.get("partition") === "1") {
        remoteAsked();
        return arrow(rows(100, 3));
      }
      await remote;
      return arrow(rows(0, 3));
    });
    const conn = await open(server, { async: true });
    const table = await conn.query("SELECT v FROM t");
    expect(Array.from(table.getChild("v")!).sort((a, b) => a - b)).toEqual([0, 1, 2, 100, 101, 102]);
    expect(submit?.get("warp-result-locations")).toBe("remote");
    const remoteReq = server.requests.find((r) => r.url.host === "worker-2.test:9000")!;
    expect(remoteReq.headers.get("authorization")).toBe("Bearer t1");
  });

  test("without result_locations the client never asks for remote partitions, and refuses one it is given", async () => {
    const server = new FakeServer();
    let submit: Headers | undefined;
    server.on("POST", /\/statements$/, (req) => {
      submit = req.headers;
      return json(
        201,
        doneDoc("q1", {
          kind: "rows",
          partitions: [
            { index: 0, location: null },
            { index: 1, location: "https://worker-2.test:9000/warp" },
          ],
          partition_order: "any",
          retained: true,
        }),
      );
    });
    server.on("GET", /\/statements\/q1\/result$/, () => arrow(rows(0, 3)));
    const conn = await open(server, { async: true });
    await expectCode(conn.query("SELECT v FROM t"), ErrorCode.clientProtocolError);
    expect(submit?.has("warp-result-locations")).toBe(false);
    expect(server.requests.some((r) => r.url.host === "worker-2.test:9000")).toBe(false);
  });

  test("a document with several partitions and no (or an unknown) partition_order is a protocol error", async () => {
    for (const order of [undefined, "sorted_somehow"]) {
      const server = new FakeServer();
      server.on("POST", /\/statements$/, () =>
        json(
          201,
          doneDoc("q1", {
            kind: "rows",
            partitions: [{ index: 0 }, { index: 1 }],
            ...(order !== undefined ? { partition_order: order } : {}),
            retained: true,
          }),
        ),
      );
      server.on("GET", /\/statements\/q1\/result$/, () => arrow(rows(0, 3)));
      const conn = await open(server, { async: true });
      await expectCode(conn.query("SELECT v FROM t"), ErrorCode.clientProtocolError);
      // The twin: with an order it reads.
      server.on("POST", /\/statements$/, () =>
        json(
          201,
          doneDoc("q1", {
            kind: "rows",
            partitions: [{ index: 0 }, { index: 1 }],
            partition_order: "interleaved",
            retained: true,
          }),
        ),
      );
      expect((await conn.query("SELECT v FROM t")).numRows).toBe(6);
    }
  });

  test("a streamed result in several partitions without Warp-Result-Order is a protocol error, never `any` (§6.10)", async () => {
    for (const order of [undefined, "shuffled"]) {
      const server = new FakeServer();
      server.capabilities.push("result_partitions");
      server.on("POST", /\/statements$/, () =>
        arrow(rows(0, 2), {
          "warp-statement-id": "q1",
          "warp-result-partitions": "2",
          ...(order !== undefined ? { "warp-result-order": order } : {}),
        }),
      );
      server.on("GET", /\/statements\/q1\/result$/, () => arrow(rows(2, 2)));
      const conn = await open(server);
      const err = await expectCode(conn.query("SELECT v FROM t"), ErrorCode.clientProtocolError);
      expect(err.message).toContain("Warp-Result-Order");
      expect(server.count("GET", /\/statements\/q1\/result$/)).toBe(0);
      // The twin: the same answer with the header is read in order.
      server.on("POST", /\/statements$/, () =>
        arrow(rows(0, 2), {
          "warp-statement-id": "q1",
          "warp-result-partitions": "2",
          "warp-result-order": "interleaved",
        }),
      );
      expect(Array.from((await conn.query("SELECT v FROM t")).getChild("v")!)).toEqual([0, 1, 2, 3]);
    }
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
    await expectCode(conn.query("SELECT v FROM t"), ErrorCode.clientProtocolError);
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
    const err = await expectCode(conn.query("SELECT v FROM t"), ErrorCode.clientIncompleteStream);
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

describe("statements (§6)", () => {
  test("a submit answered with a cancelled statement's error (409) is that error, and the statement is freed (§6.1)", async () => {
    for (const mode of [{}, { async: true }]) {
      const server = new FakeServer();
      server.on("POST", /\/statements$/, () =>
        problem(409, "statement_cancelled", { cancel_reason: "killed" }, { "warp-statement-id": "q9" }),
      );
      let deleted = false;
      server.on("DELETE", /\/statements\/q9$/, () => {
        deleted = true;
        return new Response(null, { status: 204 });
      });
      const conn = await open(server, mode);
      const err = await expectCode(conn.query("SELECT 1"), ErrorCode.statementCancelled);
      expect(err.status).toBe(409);
      expect(err.statementId).toBe("q9");
      expect(err.cancelReason).toBe("killed");
      await expect.poll(() => deleted).toBe(true);
    }
  });

  test("execution_error is a 422 with the statement's id (§11)", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () =>
      problem(422, "execution_error", { sqlstate: "22012" }, { "warp-statement-id": "q3" }),
    );
    const conn = await open(server);
    const err = await expectCode(conn.query("SELECT 1/0"), ErrorCode.executionError);
    expect(err).toMatchObject({ status: 422, statementId: "q3", sqlstate: "22012" });
  });

  test("an idempotent replay's cancelled document (200) is still the statement's error", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () =>
      json(200, { statement_id: "q1", state: "cancelled", cancel_reason: "some_future_reason" }),
    );
    const conn = await open(server);
    const err = await expectCode(conn.execute("SELECT 1"), ErrorCode.statementCancelled);
    expect(err.cancelReason).toBe("some_future_reason");
  });

  test("a statement state the client doesn't know is not terminal: it keeps polling (§12)", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => json(201, { statement_id: "q1", state: "some_future_state" }));
    let polls = 0;
    server.on("GET", /\/statements\/q1$/, () =>
      ++polls < 3
        ? json(200, { statement_id: "q1", state: "another_future_state" })
        : json(200, doneDoc("q1", { kind: "update", rows_affected: 4 })),
    );
    const conn = await open(server);
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(4);
    expect(polls).toBe(3);
  });

  test("a result of a kind the client didn't ask for is a protocol error (§12)", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => json(201, doneDoc("q1", { kind: "graph" })));
    const conn = await open(server, { async: true });
    await expectCode(conn.query("SELECT 1"), ErrorCode.clientProtocolError);
  });
});

describe("Warp-Query-Tag (§2.5)", () => {
  test("the tag is a JSON object in ASCII: other characters travel as \\u escapes", async () => {
    const server = new FakeServer();
    let tag: string | null = null;
    server.on("POST", /\/statements$/, (req) => {
      tag = req.headers.get("warp-query-tag");
      return json(200, doneDoc("q1", { kind: "update" }));
    });
    const conn = await open(server);
    const value = { job: "nächtlich", emoji: "🚀", ctrl: "a\tb", n: 1 };
    await conn.execute("SELECT 1", undefined, { queryTag: value });
    expect(tag).not.toBeNull();
    expect(/^[\x20-\x7e]*$/.test(tag!)).toBe(true);
    expect(tag).toContain("n\\u00e4chtlich");
    expect(tag).toContain("\\ud83d\\ude80");
    expect(JSON.parse(tag!)).toEqual(value);
  });

  test("a tag that is not an object, or over 4,096 bytes, is refused before anything is sent", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => json(200, doneDoc("q1", { kind: "update" })));
    const conn = await open(server);
    for (const bad of [[1, 2], "x", null, 5]) {
      await expectCode(
        conn.execute("SELECT 1", undefined, { queryTag: bad as unknown as Record<string, unknown> }),
        ErrorCode.clientInvalidArgument,
      );
    }
    // 4,096 bytes once escaped: "é" is six bytes as \u00e9.
    const fits = { k: "x".repeat(4096 - '{"k":""}'.length) };
    const over = { k: "é".repeat(700) };
    await expectCode(conn.execute("SELECT 1", undefined, { queryTag: over }), ErrorCode.clientInvalidArgument);
    expect(server.count("POST", /\/statements$/)).toBe(0);
    await conn.execute("SELECT 1", undefined, { queryTag: fits });
    expect(server.count("POST", /\/statements$/)).toBe(1);
  });
});

describe("User-Agent", () => {
  test("Node sends warp-sql-js/<version>, the package's version, unless told otherwise", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(version).toBe(pkg.version);
    const server = new FakeServer();
    await open(server);
    expect(server.requests.every((r) => r.headers.get("user-agent") === `warp-sql-js/${pkg.version}`)).toBe(true);
    const custom = new FakeServer();
    await open(custom, { userAgent: "my-app/2" });
    expect(custom.requests.every((r) => r.headers.get("user-agent") === "my-app/2")).toBe(true);
  });
});

describe("transport", () => {
  test("a TLS alert certificate_required or certificate_revoked is that refusal, not an unreachable server (§4.4)", async () => {
    for (const [alert, code] of [
      ["ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED", ErrorCode.certificateRequired],
      ["ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED", ErrorCode.certificateRevoked],
      ["ECONNREFUSED", ErrorCode.clientTransportError],
    ] as const) {
      const failing = (() =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: alert }) }),
        )) as unknown as typeof fetch;
      await expectCode(
        connect({
          url: "warp://db.test:31337",
          username: "u",
          password: "p",
          fetch: failing,
          logger: quiet,
          maxAttempts: 1,
        }),
        code,
      );
    }
  });
});

describe("capabilities (§3.1)", () => {
  test("capability names the client doesn't know are ignored", async () => {
    const server = new FakeServer();
    server.capabilities.push("some_future_capability", "acme_thing");
    server.on("POST", /\/statements$/, () => json(200, doneDoc("q1", { kind: "update", rows_affected: 1 })));
    const conn = await open(server);
    expect(await conn.execute("DELETE FROM t")).toBe(1);
  });

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

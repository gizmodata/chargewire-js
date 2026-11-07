// Lazy connect to a stopped server (§3.1, §11.2): a stand-in answering for a stopped server says
// `"state": "stopped"` in its discovery document, and the client connects without signing in or
// opening a session, because the sign-in is what starts the server. The first request that does
// work signs in; until then checks and a close send nothing.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { type Connection, ErrorCode, ChargewireError, connect } from "../../src/index.js";
import { type ResumeClock, abortError, setResumeClockForTesting } from "../../src/http.js";
import { FakeServer, json, problem } from "./fake.js";

/** Moves time forward by each wait instead of sleeping. */
class FakeClock implements ResumeClock {
  time = 1_000_000;
  readonly waits: number[] = [];
  now(): number {
    return this.time;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    this.waits.push(ms);
    this.time += ms;
    return Promise.resolve();
  }
}

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

const tokenPath = /^\/chargewire\/v1\/auth\/token$/;
const updateDoc = { statement_id: "q1", state: "succeeded", result: { kind: "update", rows_affected: 3 } };

/** A fake stand-in for a stopped server: discovery says `"state": "stopped"`. */
function stopped(state: string | null = "stopped"): FakeServer {
  const server = new FakeServer();
  server.on("GET", /^\/chargewire$/, () =>
    json(200, {
      protocol: "chargewire",
      protocol_versions: ["1"],
      capabilities: server.capabilities,
      auth: { grant_types: ["password"] },
      ...(state !== null ? { state } : {}),
    }),
  );
  server.on("POST", /\/statements$/, () => json(200, updateDoc));
  return server;
}

const sent = (server: FakeServer): string[] => server.requests.map((r) => `${r.method} ${r.url.pathname}`);

let clock: FakeClock;
let previous: ResumeClock;
beforeEach(() => {
  clock = new FakeClock();
  previous = setResumeClockForTesting(clock);
});
afterEach(() => {
  setResumeClockForTesting(previous);
});

describe("lazy connect to a stopped server (§11.2)", () => {
  test("connecting sends only the discovery request: no sign-in, no session", async () => {
    const server = stopped();
    const conn = await open(server);
    expect(sent(server)).toEqual(["GET /chargewire"]);
    expect(conn.server.capabilities).toEqual(server.capabilities);
    await conn.close();
  });

  test("reading the connection's state and closing it send nothing", async () => {
    const server = stopped();
    const conn = await open(server);
    expect(conn.closed).toBe(false);
    expect(conn.sessionId).toBe("");
    expect(conn.sessionReplacements).toBe(0);
    await conn.close();
    expect(conn.closed).toBe(true);
    expect(sent(server)).toEqual(["GET /chargewire"]);
  });

  test("the first statement signs in (waiting out server_resuming), opens the session and runs", async () => {
    const server = stopped();
    // The sign-in starts the server: the stand-in answers server_resuming twice, then it serves.
    let logins = 0;
    const issue = server.routes.find((r) => r.method === "POST" && r.pattern.source === tokenPath.source)!.handler;
    server.on("POST", tokenPath, (req, match) =>
      ++logins <= 2 ? problem(503, ErrorCode.serverResuming, {}, { "retry-after": "5" }) : issue(req, match),
    );
    const conn = await open(server, { catalog: "lake" });
    expect(logins).toBe(0);
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(3);
    expect(clock.waits).toEqual([5000, 5000]);
    expect(sent(server)).toEqual([
      "GET /chargewire",
      "POST /chargewire/v1/auth/token",
      "POST /chargewire/v1/auth/token",
      "POST /chargewire/v1/auth/token",
      "POST /chargewire/v1/sessions",
      "POST /chargewire/v1/sessions/s1/statements",
      "DELETE /chargewire/v1/sessions/s1/statements/q1", // the statement freed (§6.8)
    ]);
    const create = server.requests.find((r) => r.url.pathname === "/chargewire/v1/sessions")!;
    expect(JSON.parse(create.body)).toEqual({ options: { catalog: "lake" } });
    expect(conn.sessionId).toBe("s1");
    // From here on it is an ordinary connection.
    expect(await conn.execute("UPDATE t SET x = 2")).toBe(3);
    expect(server.tokens).toBe(1);
    expect(server.sessions).toBe(1);
    await conn.close();
    expect(server.count("DELETE", /\/sessions\/s1$/)).toBe(1);
  });

  test("a wrong password surfaces at the first statement, with the error connect would have given", async () => {
    const server = stopped();
    server.on("POST", tokenPath, () => problem(401, ErrorCode.invalidCredentials));
    const conn = await open(server);
    const err = await conn.execute("UPDATE t SET x = 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChargewireError);
    expect((err as ChargewireError).code).toBe(ErrorCode.invalidCredentials);
    expect(server.count("POST", /\/sessions$/)).toBe(0);
    expect(server.count("POST", /\/statements$/)).toBe(0);
    // The same server, serving: connect itself fails with that error.
    const eager = stopped(null);
    eager.on("POST", tokenPath, () => problem(401, ErrorCode.invalidCredentials));
    const direct = await open(eager).catch((e: unknown) => e);
    expect((direct as ChargewireError).code).toBe(ErrorCode.invalidCredentials);
    await conn.close();
  });

  test("statements sent at once share one sign-in and one session", async () => {
    const server = stopped();
    const conn = await open(server);
    expect(await Promise.all([conn.execute("UPDATE t SET x = 1"), conn.execute("UPDATE t SET x = 2")])).toEqual([3, 3]);
    expect(server.tokens).toBe(1);
    expect(server.sessions).toBe(1);
    await conn.close();
  });

  test("session options, tags, autocommit and an empty commit before the first request send nothing; then they go first", async () => {
    const server = stopped();
    server.on("PATCH", /^\/chargewire\/v1\/sessions\/[^/]+$/, (req) =>
      json(200, { options: (JSON.parse(req.body) as { options: unknown }).options, errors: {} }),
    );
    server.on("POST", /\/(commit|rollback)$/, () => new Response(null, { status: 204 }));
    // A pool-style connect: options and a session tag given at connect, more set right after.
    const conn = await open(server, { catalog: "lake", sessionOptions: { session_tag: { app: "pool" } } });
    expect(await conn.setOptions({ schema: "analytics" })).toMatchObject({ catalog: "lake", schema: "analytics" });
    await conn.setAutocommit(false);
    await conn.commit(); // nothing ran: an empty transaction
    await conn.rollback();
    expect(sent(server)).toEqual(["GET /chargewire"]);
    // The first statement: sign-in, the session with the connect-time options, the rest, the statement.
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(3);
    expect(sent(server)).toEqual([
      "GET /chargewire",
      "POST /chargewire/v1/auth/token",
      "POST /chargewire/v1/sessions",
      "PATCH /chargewire/v1/sessions/s1",
      "POST /chargewire/v1/sessions/s1/statements",
      "DELETE /chargewire/v1/sessions/s1/statements/q1",
    ]);
    const create = server.requests.find((r) => r.url.pathname === "/chargewire/v1/sessions")!;
    expect(JSON.parse(create.body)).toEqual({ options: { session_tag: { app: "pool" }, catalog: "lake" } });
    const patch = server.requests.find((r) => r.method === "PATCH")!;
    expect(JSON.parse(patch.body)).toEqual({ options: { schema: "analytics", autocommit: false } });
    await conn.commit(); // now a real one
    expect(server.count("POST", /\/commit$/)).toBe(1);
    await conn.close();
  });

  test("an option the server refuses fails the first request; the next one runs", async () => {
    const server = stopped();
    server.on("PATCH", /^\/chargewire\/v1\/sessions\/[^/]+$/, () =>
      json(200, {
        options: {},
        errors: { schema: { code: "invalid_option_value", detail: "schema 'nope' does not exist" } },
      }),
    );
    const conn = await open(server);
    await conn.setOptions({ schema: "nope" });
    expect(sent(server)).toEqual(["GET /chargewire"]);
    const err = (await conn.execute("UPDATE t SET x = 1").catch((e: unknown) => e)) as ChargewireError;
    expect(err).toBeInstanceOf(ChargewireError);
    expect(err.code).toBe("invalid_option_value");
    expect(err.message).toContain('session option "schema"');
    expect(server.count("POST", /\/statements$/)).toBe(0);
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(3);
    expect(server.count("PATCH", /\/sessions\/s1$/)).toBe(1);
    await conn.close();
  });

  test("transaction() whose work sends nothing sends nothing", async () => {
    const server = stopped();
    const conn = await open(server);
    expect(await conn.transaction(async () => 7)).toBe(7);
    expect(sent(server)).toEqual(["GET /chargewire"]);
    // Autocommit is back on: the first statement opens a session with nothing else to set.
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(3);
    expect(server.count("PATCH", /\/sessions\//)).toBe(0);
    await conn.close();
  });

  test("each connect reads discovery again: one made after the server stopped is lazy", async () => {
    const server = stopped(null); // serving
    const first = await open(server);
    expect(server.tokens).toBe(1);
    expect(first.sessionId).toBe("s1");
    // The server is stopped now (its stand-in answers), and the pool opens another connection.
    server.on("GET", /^\/chargewire$/, () =>
      json(200, {
        protocol: "chargewire",
        protocol_versions: ["1"],
        capabilities: server.capabilities,
        auth: { grant_types: ["password"] },
        state: "stopped",
      }),
    );
    const before = server.requests.length;
    const second = await open(server);
    expect(sent(server).slice(before)).toEqual(["GET /chargewire"]);
    expect(second.sessionId).toBe("");
    await second.close();
    await first.close();
  });

  test("after a Stop revoked the old connection's token, a new connect signs in fresh and runs", async () => {
    // Serving: a connection signs in (t1). A person's Stop revokes t1 (the stand-in refuses it
    // with token_revoked); the old connection must not sign in again on its own (§4.2)...
    const server = stopped(null);
    const old = await open(server);
    server.on("POST", /\/statements$/, (req) =>
      req.headers.get("authorization") === "Bearer t1"
        ? problem(401, ErrorCode.invalidToken, { reason: "token_revoked" }, { "www-authenticate": "Bearer" })
        : json(200, updateDoc),
    );
    const refused = (await old.execute("UPDATE t SET x = 1").catch((e: unknown) => e)) as ChargewireError;
    expect(refused.code).toBe(ErrorCode.invalidToken);
    expect(refused.reason).toBe("token_revoked");
    expect(server.tokens).toBe(1);
    // ...but connecting again starts it: a new connect, lazy (stopped) or not, signs in fresh.
    for (const state of ["stopped", null]) {
      server.on("GET", /^\/chargewire$/, () =>
        json(200, {
          protocol: "chargewire",
          protocol_versions: ["1"],
          capabilities: server.capabilities,
          auth: { grant_types: ["password"] },
          ...(state !== null ? { state } : {}),
        }),
      );
      const before = server.tokens;
      const fresh = await open(server);
      expect(await fresh.execute("UPDATE t SET x = 1")).toBe(3);
      expect(server.tokens).toBe(before + 1);
      const statement = server.requests.filter((r) => r.url.pathname.endsWith("/statements")).at(-1)!;
      expect(statement.headers.get("authorization")).toBe(`Bearer t${before + 1}`);
      await fresh.close();
    }
    await old.close();
  });

  for (const state of [null, "serving", "some_future_state"]) {
    test(`a server whose discovery has ${state === null ? "no state" : `state ${state}`}: connect signs in and opens the session`, async () => {
      const server = stopped(state);
      const conn = await open(server);
      expect(sent(server)).toEqual([
        "GET /chargewire",
        "POST /chargewire/v1/auth/token",
        "POST /chargewire/v1/sessions",
      ]);
      expect(conn.sessionId).toBe("s1");
      await conn.close();
    });
  }
});

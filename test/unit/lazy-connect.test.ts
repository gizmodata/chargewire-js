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

  test("statements sent at once share one sign-in and one session; a session option is work too", async () => {
    const server = stopped();
    server.on("PATCH", /^\/chargewire\/v1\/sessions\/[^/]+$/, (req) =>
      json(200, { options: (JSON.parse(req.body) as { options: unknown }).options }),
    );
    const conn = await open(server);
    expect(await Promise.all([conn.execute("UPDATE t SET x = 1"), conn.execute("UPDATE t SET x = 2")])).toEqual([3, 3]);
    expect(server.tokens).toBe(1);
    expect(server.sessions).toBe(1);
    await conn.close();
    const other = stopped();
    other.on("PATCH", /^\/chargewire\/v1\/sessions\/[^/]+$/, (req) =>
      json(200, { options: (JSON.parse(req.body) as { options: unknown }).options }),
    );
    const conn2 = await open(other);
    await conn2.setOptions({ schema: "main" });
    expect(sent(other)).toEqual([
      "GET /chargewire",
      "POST /chargewire/v1/auth/token",
      "POST /chargewire/v1/sessions",
      "PATCH /chargewire/v1/sessions/s1",
    ]);
    await conn2.close();
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

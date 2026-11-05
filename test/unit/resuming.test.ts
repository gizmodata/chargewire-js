// A server starting again after a stop answers server_resuming (503 with Retry-After) and may
// hold the login: the client waits and sends the same request again until resumeTimeout. The
// waits go through a fake clock, so these tests take milliseconds; one holds a real login 25 s.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { type Connection, ErrorCode, ChargewireError, connect } from "../../src/index.js";
import { type ResumeClock, abortError, resumeRetryAfterMs, setResumeClockForTesting } from "../../src/http.js";
import { FakeServer, json, problem } from "./fake.js";

/** Records every wait and moves its time forward by it, instead of sleeping. */
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

const resuming = (retryAfter?: string): Response =>
  problem(503, ErrorCode.serverResuming, {}, retryAfter === undefined ? {} : { "retry-after": retryAfter });

const tokenPath = /^\/chargewire\/v1\/auth\/token$/;
const updateDoc = { statement_id: "q1", state: "succeeded", result: { kind: "update", rows_affected: 3 } };

/** The first `times` logins answer server_resuming, then the fake's own token route answers. */
function resumingLogins(server: FakeServer, times: number, retryAfter?: string): () => number {
  let calls = 0;
  const issue = server.routes.find((r) => r.method === "POST" && r.pattern.source === tokenPath.source)!.handler;
  server.on("POST", tokenPath, (req, match) => (++calls <= times ? resuming(retryAfter) : issue(req, match)));
  return () => calls;
}

async function failure(work: Promise<unknown>): Promise<ChargewireError> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChargewireError);
  return err as ChargewireError;
}

function expectResumingError(err: ChargewireError): void {
  expect(err.code, String(err)).toBe(ErrorCode.serverResuming);
  expect(err.status).toBe(503);
  expect(err.detail).toBe("fake server_resuming");
  expect(err.message.startsWith("fake server_resuming (server_resuming, HTTP 503)"), err.message).toBe(true);
}

let clock: FakeClock;
let previous: ResumeClock;
beforeEach(() => {
  clock = new FakeClock();
  previous = setResumeClockForTesting(clock);
});
afterEach(() => {
  setResumeClockForTesting(previous);
});

describe("server_resuming", () => {
  test("the login is sent again until the server has resumed", async () => {
    const server = new FakeServer();
    const logins = resumingLogins(server, 3, "5");
    const conn = await open(server);
    expect(logins()).toBe(4);
    expect(clock.waits).toEqual([5000, 5000, 5000]);
    const bodies = server.requests.filter((r) => tokenPath.test(r.url.pathname)).map((r) => r.body);
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(1); // the same request, the same credential
    expect(JSON.parse(bodies[0]!)).toMatchObject({ grant_type: "password", username: "joe" });
    await conn.close();
  });

  test("a statement is sent again, under the same Idempotency-Key, until the server has resumed", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.on("POST", /\/statements$/, () => (++calls <= 2 ? resuming("2") : json(200, updateDoc)));
    const conn = await open(server);
    expect(await conn.execute("UPDATE t SET x = 1")).toBe(3);
    expect(clock.waits).toEqual([2000, 2000]);
    const submits = server.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/statements"));
    expect(submits).toHaveLength(3);
    for (const submit of submits) {
      expect(submit.headers.get("idempotency-key")).toBe(submits[0]!.headers.get("idempotency-key"));
      expect(submit.body).toBe(submits[0]!.body);
    }
    expect(server.tokens).toBe(1); // the login was not repeated
    await conn.close();
  });

  test("even a commit, which is never retried otherwise, is sent again: the server did not take it", async () => {
    const server = new FakeServer();
    let commits = 0;
    server.on("POST", /\/commit$/, () => (++commits === 1 ? resuming("1") : new Response(null, { status: 204 })));
    const conn = await open(server);
    await conn.commit();
    expect(commits).toBe(2);
    expect(clock.waits).toEqual([1000]);
    await conn.close();
  });

  test("the deadline reports the server's error", async () => {
    const server = new FakeServer();
    const logins = resumingLogins(server, Number.MAX_SAFE_INTEGER, "4");
    const err = await failure(open(server, { resumeTimeout: 10 }));
    expectResumingError(err);
    expect(err.message).toContain("still resuming after 10 s");
    // 4 + 4, then the 2 s left before the deadline, then one last try.
    expect(clock.waits).toEqual([4000, 4000, 2000]);
    expect(logins()).toBe(4);
  });

  test("the deadline also ends a statement's retries", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => resuming("60"));
    const conn = await open(server, { resumeTimeout: 120 });
    const err = await failure(conn.execute("UPDATE t SET x = 1"));
    expectResumingError(err);
    expect(err.message).toContain("still resuming after 120 s");
    expect(clock.waits).toEqual([60_000, 60_000]);
    expect(server.count("POST", /\/statements$/)).toBe(3);
    await conn.close();
  });

  test("without Retry-After the client waits 3 s", async () => {
    const server = new FakeServer();
    resumingLogins(server, 1);
    await (await open(server)).close();
    expect(clock.waits).toEqual([3000]);
  });

  test("Retry-After 0 still waits a second, so the retries never spin", async () => {
    const server = new FakeServer();
    resumingLogins(server, 2, "0");
    await (await open(server)).close();
    expect(clock.waits).toEqual([1000, 1000]);
  });

  test("a long Retry-After is capped at 60 s", async () => {
    const server = new FakeServer();
    resumingLogins(server, 2, "3600");
    await (await open(server)).close();
    expect(clock.waits).toEqual([60_000, 60_000]);
  });

  test("resumeTimeout 0 reports the first answer, without the other 503 retries either", async () => {
    const server = new FakeServer();
    const logins = resumingLogins(server, 1, "0");
    const err = await failure(open(server, { resumeTimeout: 0 }));
    expectResumingError(err);
    expect(err.message).not.toContain("still resuming");
    expect(logins()).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test("another 503 code is not the resume loop's: server_draining keeps the usual few attempts", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.on("POST", tokenPath, () => {
      calls++;
      return problem(503, ErrorCode.serverDraining, {}, { "retry-after": "0" });
    });
    const err = await failure(open(server));
    expect(err.code).toBe(ErrorCode.serverDraining);
    expect(calls).toBe(4); // maxAttempts
    expect(clock.waits).toEqual([]);
  });

  test("connect's signal stops the wait for a resuming server", async () => {
    const server = new FakeServer();
    resumingLogins(server, Number.MAX_SAFE_INTEGER, "60");
    const controller = new AbortController();
    clock.sleep = (_ms, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortError(signal)), { once: true });
        controller.abort();
      });
    const err = await failure(open(server, { signal: controller.signal }));
    expect(err.code).toBe(ErrorCode.statementCancelled);
  });

  test("a resumeTimeout that is not a number of seconds is refused", async () => {
    for (const resumeTimeout of [-1, Number.NaN, "600"]) {
      const err = await failure(open(new FakeServer(), { resumeTimeout }));
      expect(err.code).toBe(ErrorCode.clientInvalidArgument);
    }
  });

  test("the wait is Retry-After, 3 s without one, at least 1 s, at most 60 s", () => {
    expect(resumeRetryAfterMs(undefined)).toBe(3000);
    expect(resumeRetryAfterMs(0)).toBe(1000);
    expect(resumeRetryAfterMs(7000)).toBe(7000);
    expect(resumeRetryAfterMs(60_000)).toBe(60_000);
    expect(resumeRetryAfterMs(61_000)).toBe(60_000);
  });

  test("a login held for 25 s succeeds over the runtime's own fetch", { timeout: 60_000 }, async () => {
    setResumeClockForTesting(previous);
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const send = (status: number, doc: unknown): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(doc));
        };
        if (req.method === "GET" && req.url === "/chargewire") {
          send(200, { protocol: "chargewire", protocol_versions: ["1"], auth: { grant_types: ["password"] } });
        } else if (req.method === "POST" && req.url === "/chargewire/v1/auth/token") {
          setTimeout(() => send(200, { access_token: "t1", token_type: "Bearer", expires_in: 3600 }), 25_000);
        } else if (req.method === "POST" && req.url === "/chargewire/v1/sessions") {
          send(201, { session_id: "s1", options: {}, transaction: "none" });
        } else {
          res.writeHead(req.method === "DELETE" ? 204 : 404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = http.address() as AddressInfo;
      const started = performance.now();
      const conn = await connect({
        url: `http://127.0.0.1:${port}`,
        username: "joe",
        password: "pw",
        logger: quiet,
      });
      expect(performance.now() - started).toBeGreaterThanOrEqual(24_900);
      await conn.close();
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});

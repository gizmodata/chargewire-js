// Browser sign-in (§4.3): flows, polls with the secret in the body, failures as errors with
// the flow's code, the connect option and its capability check, and the redirect helpers.
import { describe, expect, test } from "vitest";

import {
  ErrorCode,
  WarpSqlError,
  beginBrowserRedirectSignIn,
  browserSignIn,
  browserSignInProvider,
  completeBrowserRedirectSignIn,
  connect,
  pollBrowserSignIn,
  startBrowserSignIn,
  takeBrowserSignInFlowId,
} from "../../src/index.js";
import { FakeServer, type FakeRequest, json, problem } from "./fake.js";

const quiet = { warn: () => {} };
const url = "warp://db.test:31337";
const secret = "pollsecretpollsecretpollsecret";
const authorizeUrl = "https://idp.test/authorize?state=abc";

async function expectCode(work: Promise<unknown>, code: string): Promise<WarpSqlError> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WarpSqlError);
  expect((err as WarpSqlError).code, String(err)).toBe(code);
  return err as WarpSqlError;
}

/** A fake server with browser sign-in: each flow completes after `pendingPolls` pending answers. */
function browserServer(opts: { pendingPolls?: number; outcome?: "complete" | "failed" } = {}) {
  const server = new FakeServer();
  server.capabilities = [...server.capabilities, "oauth_browser"];
  server.on("GET", /^\/warp$/, () =>
    json(200, {
      protocol: "warp-sql",
      protocol_versions: ["1"],
      capabilities: server.capabilities,
      auth: { grant_types: ["password"], oauth_browser: { provider: "Okta" } },
    }),
  );
  let flows = 0;
  const polls = new Map<string, number>();
  const collected = new Set<string>();
  server.on("POST", /^\/warp\/v1\/auth\/oauth\/flows$/, () => {
    const id = `f_${++flows}`;
    return json(
      201,
      {
        flow_id: id,
        poll_secret: secret,
        authorize_url: authorizeUrl,
        poll_interval_s: 0.01,
        expires_at: "2099-01-01T00:00:00Z",
      },
      { "cache-control": "no-store", location: `/warp/v1/auth/oauth/flows/${id}` },
    );
  });
  server.on("POST", /^\/warp\/v1\/auth\/oauth\/flows\/([^/]+)$/, (req: FakeRequest, match) => {
    const id = match[1]!;
    const body = JSON.parse(req.body || "{}") as { poll_secret?: unknown };
    if (typeof body.poll_secret !== "string") return problem(400, "bad_request");
    if (body.poll_secret !== secret || collected.has(id)) return problem(404, "flow_not_found");
    const seen = polls.get(id) ?? 0;
    polls.set(id, seen + 1);
    if (seen < (opts.pendingPolls ?? 0)) return json(200, { state: "pending" });
    collected.add(id);
    if (opts.outcome === "failed") {
      return json(200, { state: "failed", error: { code: "access_denied", detail: "the user said no" } });
    }
    const token = `t${++server.tokens}`;
    server.validTokens.add(token);
    return json(200, { state: "complete", access_token: token, token_type: "Bearer", expires_in: 3600 });
  });
  return server;
}

describe("browser sign-in, step by step (§4.3)", () => {
  test("a flow, then polls with the secret in the body until the token comes, once", async () => {
    const server = browserServer({ pendingPolls: 2 });
    const flow = await startBrowserSignIn({ url, fetch: server.fetch, returnTo: "/ui/?tab=1" });
    expect(flow).toEqual({
      flowId: "f_1",
      pollSecret: secret,
      authorizeUrl,
      pollIntervalS: 0.01,
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const created = server.requests.at(-1)!;
    expect(created.url.pathname).toBe("/warp/v1/auth/oauth/flows");
    expect(JSON.parse(created.body)).toEqual({ return_to: "/ui/?tab=1" });
    expect(created.headers.get("authorization")).toBeNull();

    expect(await pollBrowserSignIn({ url, fetch: server.fetch, flow })).toEqual({ state: "pending" });
    expect(await pollBrowserSignIn({ url, fetch: server.fetch, flow })).toEqual({ state: "pending" });
    const done = await pollBrowserSignIn({ url, fetch: server.fetch, flow });
    expect(done).toEqual({ state: "complete", accessToken: "t1", expiresIn: 3600 });
    for (const req of server.requests.filter((r) => r.url.pathname.startsWith("/warp/v1/auth/oauth/flows/"))) {
      expect(req.method).toBe("POST");
      expect(req.url.href).not.toContain(secret); // never in the URL
      expect(req.headers.get("authorization")).toBeNull(); // nor in a header
      expect(JSON.parse(req.body)).toEqual({ poll_secret: secret });
    }
    await expectCode(pollBrowserSignIn({ url, fetch: server.fetch, flow }), ErrorCode.flowNotFound);
  });

  test("a wrong secret is flow_not_found; a failed sign-in throws its own code", async () => {
    const server = browserServer({ outcome: "failed" });
    const flow = await startBrowserSignIn({ url, fetch: server.fetch });
    expect(JSON.parse(server.requests.at(-1)!.body)).toEqual({});
    await expectCode(
      pollBrowserSignIn({ url, fetch: server.fetch, flow: { ...flow, pollSecret: "wrong" } }),
      ErrorCode.flowNotFound,
    );
    const err = await expectCode(pollBrowserSignIn({ url, fetch: server.fetch, flow }), ErrorCode.accessDenied);
    expect(err.detail).toBe("the user said no");
    expect(err.status).toBe(401);
  });

  test("the server's refusals of a flow come through with their codes", async () => {
    const server = new FakeServer();
    server.on("POST", /\/auth\/oauth\/flows$/, () => problem(400, "invalid_return_to"));
    await expectCode(startBrowserSignIn({ url, fetch: server.fetch, returnTo: "/x" }), ErrorCode.invalidReturnTo);
    server.on("POST", /\/auth\/oauth\/flows$/, () => problem(501, "not_implemented"));
    await expectCode(startBrowserSignIn({ url, fetch: server.fetch }), ErrorCode.notImplemented);
    server.on("POST", /\/auth\/oauth\/flows$/, () => problem(429, "rate_limited", {}, { "retry-after": "5" }));
    const busy = await expectCode(startBrowserSignIn({ url, fetch: server.fetch }), ErrorCode.rateLimited);
    expect(busy.retryAfterMs).toBe(5000);
    // Not sent again by itself: a retry would create another flow.
    expect(server.count("POST", /\/auth\/oauth\/flows$/)).toBe(3);
  });

  test("refused before sending: an absolute returnTo, a malformed flow, an answer without a secret", async () => {
    const server = browserServer();
    for (const returnTo of ["https://evil.test/", "evil.test", ""]) {
      await expectCode(startBrowserSignIn({ url, fetch: server.fetch, returnTo }), ErrorCode.invalidArgument);
    }
    await expectCode(
      pollBrowserSignIn({ url, fetch: server.fetch, flow: { flowId: "../sessions", pollSecret: secret } }),
      ErrorCode.invalidArgument,
    );
    expect(server.requests).toHaveLength(0);
    server.on("POST", /\/auth\/oauth\/flows$/, () => json(201, { flow_id: "f_1", authorize_url: authorizeUrl }));
    await expectCode(startBrowserSignIn({ url, fetch: server.fetch }), ErrorCode.protocolError);
  });

  test("the provider's name from discovery", () => {
    const doc = { protocol: "warp-sql", protocol_versions: ["1"] };
    expect(browserSignInProvider({ ...doc, auth: { oauth_browser: { provider: "Okta" } } })).toBe("Okta");
    expect(browserSignInProvider({ ...doc, auth: { oauth_browser: {} } })).toBeUndefined();
    expect(browserSignInProvider(doc)).toBeUndefined();
  });
});

describe("browserSignIn and connect", () => {
  test("browserSignIn opens the URL and polls until done; it gives up at its timeout", async () => {
    const server = browserServer({ pendingPolls: 3 });
    const opened: string[] = [];
    const result = await browserSignIn({ url, fetch: server.fetch, openUrl: (u) => void opened.push(u) });
    expect(opened).toEqual([authorizeUrl]);
    expect(result).toEqual({ accessToken: "t1", expiresIn: 3600 });

    const slow = browserServer({ pendingPolls: 1_000_000 });
    await expectCode(
      browserSignIn({ url, fetch: slow.fetch, openUrl: () => {}, timeoutMs: 50 }),
      ErrorCode.statementTimeout,
    );
    await expectCode(browserSignIn({ url, fetch: slow.fetch } as never), ErrorCode.invalidArgument);
  });

  test('connect with authType "oauth_browser" signs in through the browser and uses the token', async () => {
    const server = browserServer({ pendingPolls: 1 });
    server.on("POST", /\/statements$/, () =>
      json(200, { statement_id: "q1", state: "succeeded", result: { kind: "update", rows_affected: 1 } }),
    );
    const debug: string[] = [];
    const opened: string[] = [];
    const conn = await connect({
      url,
      authType: "oauth_browser",
      openUrl: (u) => void opened.push(u),
      fetch: server.fetch,
      logger: { ...quiet, debug: (m, f) => debug.push(m + JSON.stringify(f ?? {})) },
    });
    expect(opened).toEqual([authorizeUrl]);
    expect(await conn.execute("DELETE FROM t")).toBe(1);
    const statement = server.requests.find((r) => r.url.pathname.endsWith("/statements"))!;
    expect(statement.headers.get("authorization")).toBe("Bearer t1");
    expect(server.count("POST", /\/auth\/token$/)).toBe(0);
    // Neither the poll secret nor the token reaches the logs.
    expect(debug.join("\n")).not.toContain(secret);
    expect(debug.join("\n")).not.toMatch(/\bt1\b/);
    await conn.close();
  });

  test("refused when the server lists no oauth_browser, before any flow is created", async () => {
    const server = new FakeServer();
    let opened = false;
    await expectCode(
      connect({
        url,
        authType: "oauth_browser",
        openUrl: () => void (opened = true),
        fetch: server.fetch,
        logger: quiet,
      }),
      ErrorCode.notImplemented,
    );
    expect(opened).toBe(false);
    expect(server.count("POST", /\/auth\/oauth\/flows$/)).toBe(0);
  });

  test("bad combinations are refused", async () => {
    const server = browserServer();
    const base = { url, fetch: server.fetch, logger: quiet };
    await expectCode(connect({ ...base, authType: "oauth_browser" }), ErrorCode.invalidArgument);
    await expectCode(
      connect({ ...base, authType: "oauth_browser", openUrl: () => {}, username: "u", password: "p" }),
      ErrorCode.invalidArgument,
    );
    await expectCode(connect({ ...base, username: "u", password: "p", openUrl: () => {} }), ErrorCode.invalidArgument);
    await expectCode(
      connect({ ...base, authType: "oauth_browser", openUrl: () => {}, browserSignInTimeoutMs: -1 }),
      ErrorCode.invalidArgument,
    );
    expect(server.requests).toHaveLength(0);
  });
});

describe("pages that come back (§4.3.3)", () => {
  test("takeBrowserSignInFlowId reads and strips the fragment", () => {
    expect(takeBrowserSignInFlowId("https://db.test/ui/?a=1#warp_oauth_flow=f_abc")).toEqual({
      flowId: "f_abc",
      url: "https://db.test/ui/?a=1",
    });
    expect(takeBrowserSignInFlowId("https://db.test/ui/#tab=2&warp_oauth_flow=f_abc")).toEqual({
      flowId: "f_abc",
      url: "https://db.test/ui/#tab=2",
    });
    expect(takeBrowserSignInFlowId("https://db.test/ui/")).toBeUndefined();
    expect(takeBrowserSignInFlowId("https://db.test/ui/#warp_oauth_flow=")).toBeUndefined();
    expect(takeBrowserSignInFlowId("https://db.test/ui/#warp_oauth_flow=..%2Fsessions")).toBeUndefined();
  });

  class MemoryStorage {
    readonly items = new Map<string, string>();
    getItem = (k: string): string | null => this.items.get(k) ?? null;
    setItem = (k: string, v: string): void => void this.items.set(k, v);
    removeItem = (k: string): void => void this.items.delete(k);
  }

  test("begin keeps the secret in this tab and goes to the provider; complete collects the token", async () => {
    const server = browserServer();
    const storage = new MemoryStorage();
    const went: string[] = [];
    await beginBrowserRedirectSignIn({
      url,
      fetch: server.fetch,
      returnTo: "/ui/",
      storage,
      assign: (u) => void went.push(u),
    });
    expect(went).toEqual([authorizeUrl]);
    expect(JSON.parse(server.requests.at(-1)!.body)).toEqual({ return_to: "/ui/" });
    expect([...storage.items.keys()]).toEqual(["warp-sql:browser-sign-in:f_1"]);

    const replaced: string[] = [];
    const result = await completeBrowserRedirectSignIn({
      url,
      fetch: server.fetch,
      href: "https://db.test/ui/#warp_oauth_flow=f_1",
      storage,
      replaceUrl: (u) => void replaced.push(u),
    });
    expect(result).toEqual({ accessToken: "t1", expiresIn: 3600 });
    expect(replaced).toEqual(["https://db.test/ui/"]);
    expect(storage.items.size).toBe(0);
  });

  test("a flow this tab did not start is ignored, and no fragment means nothing to do", async () => {
    const server = browserServer();
    const storage = new MemoryStorage();
    const replaced: string[] = [];
    const base = { url, fetch: server.fetch, storage, replaceUrl: (u: string) => void replaced.push(u) };
    expect(await completeBrowserRedirectSignIn({ ...base, href: "https://db.test/ui/" })).toBeUndefined();
    expect(
      await completeBrowserRedirectSignIn({ ...base, href: "https://db.test/ui/#warp_oauth_flow=f_9" }),
    ).toBeUndefined();
    expect(replaced).toEqual(["https://db.test/ui/"]); // the fragment goes either way
    expect(server.requests).toHaveLength(0); // nothing polled for someone else's flow
  });

  test("a failed sign-in comes back as its error", async () => {
    const server = browserServer({ outcome: "failed" });
    const storage = new MemoryStorage();
    await beginBrowserRedirectSignIn({ url, fetch: server.fetch, returnTo: "/ui/", storage, assign: () => {} });
    await expectCode(
      completeBrowserRedirectSignIn({
        url,
        fetch: server.fetch,
        href: "https://db.test/ui/#warp_oauth_flow=f_1",
        storage,
        replaceUrl: () => {},
      }),
      ErrorCode.accessDenied,
    );
  });
});

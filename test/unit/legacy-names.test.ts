// Connection strings saved before the protocol's rename keep working, silently, and so do
// servers from before it (in their own spelling).

import { tableFromArrays } from "apache-arrow";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ChargewireError,
  ErrorCode,
  connect,
  defaultSchemes,
  parseUrl,
  startBrowserSignIn,
  takeBrowserSignInFlowId,
} from "../../src/index.js";
import { adoptLegacyBasePath, adoptLegacyScheme } from "../../src/legacy-names.js";
import { FakeServer, arrow, json, problem } from "./fake.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connection strings from before the rename", () => {
  test.each([
    ["warp://db.example.com:31337", "https://db.example.com:31337/chargewire"],
    ["WARP://H:1", "https://h:1/chargewire"],
    ["Warp://h:1?tls=true", "https://h:1/chargewire"],
    ["warp://127.0.0.1:31337?tls=false", "http://127.0.0.1:31337/chargewire"],
    ["warp://h:443?tls=false", "http://h:443/chargewire"],
    ["warp://[::1]:9", "https://[::1]:9/chargewire"],
    // The old default base path, written out, is the current one.
    ["warp://h:1/warp", "https://h:1/chargewire"],
    ["warp://h:1/warp/?tls=false", "http://h:1/chargewire"],
    ["https://h:1/warp", "https://h:1/chargewire"],
    ["http://h:8080/warp/", "http://h:8080/chargewire"],
    // A custom prefix is the server's own choice and stays as it is.
    ["warp://h:1/custom/prefix", "https://h:1/custom/prefix"],
    ["warp://h:1/custom/warp", "https://h:1/custom/warp"],
    ["https://h:1/warpdrive", "https://h:1/warpdrive"],
  ])("%s → %s", (raw, want) => {
    expect(parseUrl(raw).href).toBe(want);
  });

  test("the mapping writes nothing to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    parseUrl("warp://h:1/warp?tls=false");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test("the old scheme still follows the current scheme's rules", () => {
    for (const raw of ["warp://h:1?tls=maybe", "warp://h:1?color=blue", "warp://:1", "warp://joe:s3cret@h:1"]) {
      let caught: unknown;
      try {
        parseUrl(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught, raw).toBeInstanceOf(ChargewireError);
      expect((caught as ChargewireError).code).toBe(ErrorCode.clientInvalidArgument);
      expect((caught as ChargewireError).message).not.toContain("s3cret");
    }
  });

  test("a wrapper's schemes decide: no current scheme, no mapping; its own old scheme wins", () => {
    const branded = { hardcharger: { tls: true, tlsParameter: true, defaultPort: 31337 } };
    expect(() => parseUrl("warp://h:1", branded)).toThrow(/the scheme must be one of hardcharger:\/\//);
    const own = { ...defaultSchemes, warp: { tls: false, defaultPort: 7 } };
    expect(parseUrl("warp://h", own).href).toBe("http://h:7/chargewire");
    // A wrapper's scheme with the old default base path written out reaches the current one.
    expect(parseUrl("hardcharger://h/warp", { ...defaultSchemes, ...branded }).href).toBe("https://h:31337/chargewire");
  });

  test("the helpers leave everything else alone", () => {
    expect(adoptLegacyScheme("chargewire://h:1", defaultSchemes)).toBe("chargewire://h:1");
    expect(adoptLegacyScheme("https://warp:1", defaultSchemes)).toBe("https://warp:1");
    expect(adoptLegacyScheme("warpx://h:1", defaultSchemes)).toBe("warpx://h:1");
    expect(adoptLegacyScheme("warp:/h", defaultSchemes)).toBe("warp:/h");
    expect(adoptLegacyScheme("warp://h:1/warp", defaultSchemes)).toBe("chargewire://h:1/warp");
    expect(adoptLegacyBasePath("/warp", "/chargewire")).toBe("/chargewire");
    expect(adoptLegacyBasePath("/WARP", "/chargewire")).toBe("/WARP");
    expect(adoptLegacyBasePath("", "/chargewire")).toBe("");
    expect(adoptLegacyBasePath("/x/warp", "/chargewire")).toBe("/x/warp");
  });
});

/**
 * A server from before the rename: the fake server, reached only under /warp with Warp-*
 * headers and urn:warp-sql:error: types; /chargewire is not routed. `seen` keeps what was
 * asked, as sent.
 */
function preRename(server: FakeServer) {
  const seen: Array<{ method: string; path: string; headers: string[] }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const sent = new Headers(init?.headers);
    seen.push({ method: init?.method ?? "GET", path: url.pathname, headers: [...sent.keys()] });
    if (!/^\/warp(\/|$)/.test(url.pathname)) {
      return new Response(JSON.stringify({ type: "urn:warp-sql:error:not_found", status: 404, code: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/problem+json", "warp-request-id": "r404" },
      });
    }
    url.pathname = url.pathname.replace(/^\/warp/, "/chargewire");
    const headers = new Headers();
    sent.forEach((v, k) => headers.set(k.replace(/^warp-/, "chargewire-"), v));
    const resp = await server.fetch(url, { ...init, headers });
    const out = new Headers();
    resp.headers.forEach((v, k) => out.set(k.replace(/^chargewire-/, "warp-"), v));
    let body: BodyInit | null = resp.body;
    if ((resp.headers.get("content-type") ?? "").includes("json")) {
      body = (await resp.text())
        .replace(/"protocol":"chargewire"/, '"protocol":"warp-sql"')
        .replaceAll("urn:chargewire:error:", "urn:warp-sql:error:");
    }
    return new Response(resp.status === 204 ? null : body, { status: resp.status, headers: out });
  };
  return { fetch, seen };
}

const quiet = { warn: () => {} };

/** The error `work` fails with (a success fails the test). */
const failure = (work: Promise<unknown>): Promise<ChargewireError> =>
  work.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as ChargewireError,
  );

describe("servers from before the rename", () => {
  test("found at the old base path after a 404, discovered once, and spoken to in their spelling", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, (req) => {
      expect(req.headers.get("chargewire-query-tag")).toBe('{"job":"x"}');
      return arrow(tableFromArrays({ v: [7] }), { "chargewire-statement-id": "q1" });
    });
    const old = preRename(server);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const conn = await connect({
      url: "chargewire://db.test:31337",
      username: "joe",
      password: "pw",
      fetch: old.fetch,
    });
    expect(conn.server.protocol).toBe("chargewire");
    const table = await conn.query("SELECT 7 AS v", undefined, { queryTag: { job: "x" } });
    expect(Number(table.getChild("v")!.get(0))).toBe(7);
    await conn.close();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    expect(old.seen.filter((r) => r.path === "/chargewire" || r.path === "/warp").map((r) => r.path)).toEqual([
      "/chargewire",
      "/warp",
    ]);
    expect(old.seen.slice(2).every((r) => r.path.startsWith("/warp/"))).toBe(true);
    const sentNames = old.seen.flatMap((r) => r.headers);
    expect(sentNames).toContain("warp-query-tag");
    expect(sentNames.some((n) => n.startsWith("chargewire-"))).toBe(false);
  });

  test("errors read in the current spelling: code, type, request id", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () =>
      problem(
        400,
        "sql_error",
        { type: "urn:chargewire:error:sql_error", sqlstate: "42P01" },
        {
          "chargewire-request-id": "r1",
          "chargewire-statement-id": "q9",
        },
      ),
    );
    const conn = await connect({
      url: "chargewire://db.test:31337",
      username: "joe",
      password: "pw",
      fetch: preRename(server).fetch,
      logger: quiet,
    });
    const err = await failure(conn.query("SELECT * FROM nowhere"));
    expect(err).toBeInstanceOf(ChargewireError);
    expect(err.code).toBe(ErrorCode.sqlError);
    expect(err.type).toBe("urn:chargewire:error:sql_error");
    expect(err.sqlstate).toBe("42P01");
    expect(err.requestId).toBe("r1");
    expect(err.statementId).toBe("q9");
    await conn.close();
  });

  test("a custom base path never falls back", async () => {
    const server = new FakeServer();
    const old = preRename(server);
    const err = await failure(
      connect({
        url: "https://db.test:31337/custom",
        username: "joe",
        password: "pw",
        fetch: old.fetch,
        logger: quiet,
      }),
    );
    expect(err).toBeInstanceOf(ChargewireError);
    expect(err.code).toBe(ErrorCode.clientProtocolError);
    expect(old.seen.map((r) => r.path)).toEqual(["/custom"]);
  });

  test("when the old base path is no pre-rename server either, the original error stands", async () => {
    const seen: string[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      return url.pathname === "/warp"
        ? json(200, { protocol: "something-else", protocol_versions: ["1"] })
        : new Response("nothing here", { status: 404 });
    };
    const err = await failure(
      connect({
        url: "chargewire://db.test:1",
        username: "j",
        password: "p",
        fetch,
        logger: quiet,
      }),
    );
    expect(err.code).toBe(ErrorCode.clientProtocolError);
    expect(err.message).toContain("https://db.test:1/chargewire does not describe a Chargewire server");
    expect(err.message.toLowerCase()).not.toContain("warp");
    expect(seen).toEqual(["/chargewire", "/warp"]);
  });

  test("a current server is never asked at the old base path", async () => {
    const server = new FakeServer();
    server.on("POST", /\/statements$/, () => problem(404, "not_found"));
    const conn = await connect({
      url: "chargewire://db.test:31337",
      username: "joe",
      password: "pw",
      fetch: server.fetch,
    });
    await conn.query("SELECT 1").catch(() => {});
    await conn.close();
    expect(server.requests.some((r) => r.url.pathname.startsWith("/warp"))).toBe(false);
    expect(server.count("GET", /^\/chargewire$/)).toBe(1);
  });

  test("browser sign-in on a current server without it: the 404 stands, the old base path is not asked", async () => {
    const server = new FakeServer();
    const err = await failure(startBrowserSignIn({ url: "chargewire://db.test:31337", fetch: server.fetch }));
    expect(err.code).toBe(ErrorCode.notFound);
    expect(server.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /chargewire/v1/auth/oauth/flows",
      "GET /chargewire",
    ]);
  });

  test("browser sign-in: flows on a pre-rename server, and its fragment key", async () => {
    const server = new FakeServer();
    server.on("POST", /^\/chargewire\/v1\/auth\/oauth\/flows$/, () =>
      json(201, { flow_id: "f1", poll_secret: "s", authorize_url: "https://idp.test/a", poll_interval_s: 1 }),
    );
    const old = preRename(server);
    const flow = await startBrowserSignIn({ url: "chargewire://db.test:31337", fetch: old.fetch });
    expect(flow.flowId).toBe("f1");
    expect(old.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /chargewire/v1/auth/oauth/flows",
      "GET /chargewire",
      "GET /warp",
      "POST /warp/v1/auth/oauth/flows",
    ]);
    // A later call to the same server speaks its spelling at once.
    await startBrowserSignIn({ url: "chargewire://db.test:31337", fetch: old.fetch });
    expect(old.seen.at(-1)).toMatchObject({ method: "POST", path: "/warp/v1/auth/oauth/flows" });
    expect(old.seen.length).toBe(5);

    expect(takeBrowserSignInFlowId("https://app.test/p?x=1#warp_oauth_flow=f1&tab=2")).toEqual({
      flowId: "f1",
      url: "https://app.test/p?x=1#tab=2",
    });
    expect(takeBrowserSignInFlowId("https://app.test/p#chargewire_oauth_flow=f2")?.flowId).toBe("f2");
  });
});

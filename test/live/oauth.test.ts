// Licensed under the Apache License, Version 2.0.
//
// Browser sign-in (§4.3) against a real server and a mock identity provider (idp.ts). The
// server's flags are a template, CHARGEWIRE_JS_TEST_SERVER_OAUTH_ARGS (default: chargewire-duckdb's),
// with {issuer}, {client_id}, {identity} and {port}; the client secret goes in the variable
// CHARGEWIRE_JS_TEST_SERVER_OAUTH_SECRET_ENV names (default CHARGEWIRE_DUCKDB_OAUTH_CLIENT_SECRET).
// For Hardcharger:
//
//   CHARGEWIRE_JS_TEST_SERVER_OAUTH_ARGS='--token-allowed-issuer {issuer} --token-allowed-audience {client_id}
//     --token-default-role admin --token-authorized-emails {identity} --oauth-client-id {client_id}
//     --oauth-base-url http://127.0.0.1:{port}'
//   CHARGEWIRE_JS_TEST_SERVER_OAUTH_SECRET_ENV=HARDCHARGER_OAUTH_CLIENT_SECRET

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ErrorCode,
  beginBrowserRedirectSignIn,
  completeBrowserRedirectSignIn,
  connect,
  pollBrowserSignIn,
  startBrowserSignIn,
} from "../../src/index.js";
import { type RunningServer, env, launchServer } from "./harness.js";
import { type MockIdp, startIdp } from "./idp.js";
import { expectCode, quiet, reached, scalar, uri } from "./helpers.js";

const identity = "alice@example.com";
let idp: MockIdp;
let server: RunningServer;

beforeAll(async () => {
  idp = await startIdp();
  const template = env(
    "CHARGEWIRE_JS_TEST_SERVER_OAUTH_ARGS",
    "--oauth-issuer {issuer} --oauth-client-id {client_id} --oauth-identities {identity}",
  );
  const args = template
    .split(/\s+/)
    .filter((a) => a !== "")
    .map((a) => a.replace("{issuer}", idp.issuer).replace("{client_id}", idp.clientId).replace("{identity}", identity));
  server = await launchServer(args, {
    [env("CHARGEWIRE_JS_TEST_SERVER_OAUTH_SECRET_ENV", "CHARGEWIRE_DUCKDB_OAUTH_CLIENT_SECRET")]: idp.clientSecret,
  });
});

afterAll(async () => {
  await server?.stop();
  await idp?.stop();
});

/** What a browser does with the sign-in URL: through the provider to the server's callback. */
async function browse(authorizeUrl: string): Promise<Response> {
  const atIdp = await fetch(authorizeUrl, { redirect: "manual" });
  expect(atIdp.status).toBe(302);
  const callback = atIdp.headers.get("location")!;
  expect(callback.startsWith(`http://${server.host}/chargewire/`)).toBe(true);
  return fetch(callback, { redirect: "manual" });
}

describe("browser sign-in (live)", () => {
  test('connect with authType "oauth_browser": the token runs SQL', async () => {
    reached();
    idp.email = identity;
    let opened = 0;
    const conn = await connect({
      url: uri(server),
      authType: "oauth_browser",
      logger: quiet,
      openUrl: async (url) => {
        opened++;
        const page = await browse(url);
        expect(page.status).toBe(200);
        await page.text();
      },
    });
    try {
      expect(opened).toBe(1);
      expect(await scalar(conn, "SELECT 41 + 1")).toBe(42);
    } finally {
      await conn.close();
    }
  });

  test("the poll secret is required, and the token is handed out once", async () => {
    reached();
    const target = { url: uri(server) };
    const flow = await startBrowserSignIn(target);
    expect(flow.authorizeUrl).not.toContain(flow.pollSecret);
    expect(await pollBrowserSignIn({ ...target, flow })).toEqual({ state: "pending" });
    await (await browse(flow.authorizeUrl)).text();
    await expectCode(pollBrowserSignIn({ ...target, flow: { ...flow, pollSecret: "wrong" } }), ErrorCode.flowNotFound);
    const done = await pollBrowserSignIn({ ...target, flow });
    expect(done.state).toBe("complete");
    await expectCode(pollBrowserSignIn({ ...target, flow }), ErrorCode.flowNotFound);
  });

  test("a user the server does not allow, and a refusal at the provider, fail with their codes", async () => {
    reached();
    const target = { url: uri(server) };
    idp.email = "mallory@example.org";
    try {
      const flow = await startBrowserSignIn(target);
      await (await browse(flow.authorizeUrl)).text();
      await expectCode(pollBrowserSignIn({ ...target, flow }), ErrorCode.invalidCredentials);
    } finally {
      idp.email = identity;
    }
    idp.deny = true;
    try {
      const flow = await startBrowserSignIn(target);
      await (await browse(flow.authorizeUrl)).text();
      await expectCode(pollBrowserSignIn({ ...target, flow }), ErrorCode.accessDenied);
    } finally {
      idp.deny = false;
    }
  });

  test("a page: returnTo comes back with the flow id in the fragment, and completes", async () => {
    reached();
    const target = { url: uri(server) };
    const items = new Map<string, string>();
    const storage = {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    };
    let authorizeUrl = "";
    await beginBrowserRedirectSignIn({ ...target, returnTo: "/ui/?tab=1", storage, assign: (u) => (authorizeUrl = u) });
    const redirect = await browse(authorizeUrl);
    expect(redirect.status).toBe(303);
    const location = new URL(redirect.headers.get("location")!, `http://${server.host}`);
    expect(location.pathname + location.search).toBe("/ui/?tab=1");
    expect(location.hash).toMatch(/^#chargewire_oauth_flow=[A-Za-z0-9._~-]+$/);
    let shown = "";
    const result = await completeBrowserRedirectSignIn({
      ...target,
      href: location.href,
      storage,
      replaceUrl: (u) => (shown = u),
    });
    expect(result?.accessToken).toBeTruthy();
    expect(shown).toBe(`http://${server.host}/ui/?tab=1`);
    const conn = await connect({ url: uri(server), token: result!.accessToken, logger: quiet });
    try {
      expect(await scalar(conn, "SELECT 1")).toBe(1);
    } finally {
      await conn.close();
    }
    // "//host" passes the client's check (it starts with /); the server refuses it.
    await expectCode(startBrowserSignIn({ ...target, returnTo: "//evil.example/" }), ErrorCode.invalidReturnTo);
  });
});

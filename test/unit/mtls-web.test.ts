// The browser build: a client certificate comes from the browser, so requests go with
// credentials "include", and Node's tls settings are refused.
import { describe, expect, test, vi } from "vitest";

import { ErrorCode, ChargewireError, connect } from "../../src/index.js";
import { FakeServer, json } from "./fake.js";

vi.mock("#platform", async () => import("../../src/platform/web.js"));

const quiet = { warn: () => {} };

function certificateServer(): FakeServer {
  const server = new FakeServer();
  server.on("GET", /^\/chargewire$/, () =>
    json(200, {
      protocol: "chargewire",
      protocol_versions: ["1"],
      capabilities: [...server.capabilities, "mtls_identity"],
      auth: { grant_types: ["password", "client_certificate"] },
    }),
  );
  return server;
}

function spying(server: FakeServer): { fetch: typeof fetch; modes: Array<RequestCredentials | undefined> } {
  const modes: Array<RequestCredentials | undefined> = [];
  return {
    modes,
    fetch: (input, init) => {
      modes.push(init?.credentials);
      return server.fetch(input, init);
    },
  };
}

describe("client certificate sign-in in a browser", () => {
  test('every request goes with credentials "include"', async () => {
    const server = certificateServer();
    const spy = spying(server);
    const conn = await connect({
      url: "https://db.test",
      authType: "client_certificate",
      fetch: spy.fetch,
      logger: quiet,
    });
    await conn.close();
    expect(spy.modes.length).toBeGreaterThan(2); // discovery, the grant, the session, its close
    expect(spy.modes.every((m) => m === "include")).toBe(true);
  });

  test("a password sign-in keeps the browser's default; fetchCredentials overrides either", async () => {
    const server = certificateServer();
    const spy = spying(server);
    await (
      await connect({ url: "https://db.test", username: "u", password: "p", fetch: spy.fetch, logger: quiet })
    ).close();
    expect(spy.modes.every((m) => m === undefined)).toBe(true);
    spy.modes.length = 0;
    await (
      await connect({
        url: "https://db.test",
        username: "u",
        password: "p",
        fetchCredentials: "include",
        fetch: spy.fetch,
        logger: quiet,
      })
    ).close();
    expect(spy.modes.every((m) => m === "include")).toBe(true);
  });

  test("no tls settings are needed (the browser has the certificate), and none are accepted", async () => {
    const err = await connect({ url: "https://db.test", authType: "client_certificate", tls: {}, logger: quiet }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ChargewireError);
    expect((err as ChargewireError).code).toBe(ErrorCode.clientInvalidArgument);
    expect((err as ChargewireError).message).toContain("tls options apply in Node");
  });
});

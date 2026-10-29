// Client certificate sign-in (§4.4), in Node: the grant, what is refused before anything is
// sent, the capability check, and the certificate error codes.
import { describe, expect, test } from "vitest";

import { ErrorCode, ChargewireError, connect } from "../../src/index.js";
import { FakeServer, json, problem } from "./fake.js";

const quiet = { warn: () => {} };

/** A fake server that offers certificate sign-in. */
function certificateServer(): FakeServer {
  const server = new FakeServer();
  server.capabilities = [...server.capabilities, "mtls_identity"];
  server.on("GET", /^\/chargewire$/, () =>
    json(200, {
      protocol: "chargewire",
      protocol_versions: ["1"],
      capabilities: server.capabilities,
      auth: { grant_types: ["password", "client_certificate"] },
    }),
  );
  return server;
}

const openCertificate = (server: FakeServer, extra: Record<string, unknown> = {}) =>
  connect({
    url: "chargewire://db.test:31337",
    authType: "client_certificate",
    fetch: server.fetch,
    logger: quiet,
    ...extra,
  });

async function expectCode(work: Promise<unknown>, code: string): Promise<ChargewireError> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChargewireError);
  expect((err as ChargewireError).code, String(err)).toBe(code);
  return err as ChargewireError;
}

describe("client certificate sign-in (§4.4)", () => {
  test("the grant carries no fields, and renewing repeats it", async () => {
    const server = certificateServer();
    server.expiresIn = 1;
    server.on("POST", /\/statements$/, () =>
      json(200, { statement_id: "q1", state: "succeeded", result: { kind: "update", rows_affected: 1 } }),
    );
    const conn = await openCertificate(server);
    const grants = () =>
      server.requests.filter((r) => r.url.pathname.endsWith("/auth/token")).map((r) => JSON.parse(r.body) as unknown);
    expect(grants()).toEqual([{ grant_type: "client_certificate" }]);
    await new Promise((r) => setTimeout(r, 800)); // past three quarters of the token's life
    expect(await conn.execute("DELETE FROM t")).toBe(1);
    expect(grants()).toEqual([{ grant_type: "client_certificate" }, { grant_type: "client_certificate" }]);
    // In Node the runtime's credentials mode is left alone.
    expect(server.requests.length).toBeGreaterThan(0);
    await conn.close();
  });

  test("other credentials beside it are refused before anything is sent", async () => {
    for (const extra of [
      { username: "joe", password: "pw" },
      { token: "t" },
      { tokenProvider: () => "t" },
      { subjectToken: "jwt" },
      { username: "joe" },
    ]) {
      const server = certificateServer();
      const err = await expectCode(openCertificate(server, extra), ErrorCode.clientInvalidArgument);
      expect(err.message).toContain("signs in with the client certificate alone");
      expect(server.requests).toEqual([]);
    }
  });

  test("plain HTTP is refused before anything is sent", async () => {
    const server = certificateServer();
    const err = await expectCode(
      openCertificate(server, { url: "chargewire://db.test:31337?tls=false" }),
      ErrorCode.clientInvalidArgument,
    );
    expect(err.message).toContain("needs TLS");
    expect(server.requests).toEqual([]);
  });

  test("in Node it needs tls.cert and tls.key, and they go together", async () => {
    const err = await expectCode(
      connect({ url: "chargewire://db.test:31337", authType: "client_certificate", logger: quiet }),
      ErrorCode.clientInvalidArgument,
    );
    expect(err.message).toContain("set tls.cert and tls.key");
    const half = await expectCode(
      connect({ url: "chargewire://db.test:31337", authType: "client_certificate", tls: { cert: "x" }, logger: quiet }),
      ErrorCode.clientInvalidArgument,
    );
    expect(half.message).toContain("tls.cert and tls.key go together");
  });

  test("an unknown authType is refused", async () => {
    const err = await expectCode(
      connect({ url: "chargewire://db.test:31337", authType: "kerberos" as never, logger: quiet }),
      ErrorCode.clientInvalidArgument,
    );
    expect(err.message).toContain('"password", "client_certificate" or "oauth_browser"');
  });

  test("a server without capability mtls_identity is refused before the grant is sent", async () => {
    const server = new FakeServer(); // offers the password grant only
    const err = await expectCode(openCertificate(server), ErrorCode.notImplemented);
    expect(err.message).toContain("mtls_identity");
    expect(server.count("POST", /\/auth\/token$/)).toBe(0);
    // The capability without the grant (certificate sign-in turned off) is refused too.
    const off = new FakeServer();
    off.capabilities = [...off.capabilities, "mtls_identity"];
    await expectCode(openCertificate(off), ErrorCode.notImplemented);
    // The twin: a server offering both signs in.
    await (await openCertificate(certificateServer())).close();
  });

  test("the certificate refusals keep their codes, and are not answered with a new token", async () => {
    for (const code of [
      ErrorCode.certificateRequired,
      ErrorCode.unknownCertificateIdentity,
      ErrorCode.certificateRevoked,
      ErrorCode.certificateMismatch,
      ErrorCode.certificateIdentityMismatch,
    ]) {
      // At sign-in.
      const atSignIn = certificateServer();
      atSignIn.on("POST", /^\/chargewire\/v1\/auth\/token$/, () =>
        problem(401, code, {}, { "www-authenticate": "Bearer" }),
      );
      const err = await expectCode(openCertificate(atSignIn), code);
      expect(err.status).toBe(401);
      // On a statement: the token is not the problem, so it is not renewed.
      const later = certificateServer();
      later.on("POST", /\/statements$/, () => problem(401, code, {}, { "www-authenticate": "Bearer" }));
      const conn = await openCertificate(later);
      await expectCode(conn.execute("SELECT 1"), code);
      expect(later.tokens).toBe(1);
    }
    expect(ErrorCode.unsupportedGrantType).toBe("unsupported_grant_type");
  });

  test("fetchCredentials is passed to fetch", async () => {
    const server = certificateServer();
    const modes: Array<RequestCredentials | undefined> = [];
    const spy: typeof fetch = (input, init) => {
      modes.push(init?.credentials);
      return server.fetch(input, init);
    };
    await (await openCertificate(server, { fetch: spy, fetchCredentials: "include" })).close();
    expect(modes.length).toBeGreaterThan(2);
    expect(modes.every((m) => m === "include")).toBe(true);
    // The twin: without it, Node leaves the mode unset.
    modes.length = 0;
    await (await openCertificate(server, { fetch: spy })).close();
    expect(modes.every((m) => m === undefined)).toBe(true);
  });
});

// Licensed under the Apache License, Version 2.0.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import { ErrorCode, connect, defaultSchemes } from "../../src/index.js";
import { makeCA } from "./tls-ca.js";
import { type RunningServer, freePort, launchServer, rawToken, testUsername } from "./harness.js";
import { expectCode, numbers, open, quiet, reached, scalar, shared, uri } from "./helpers.js";

async function started(extra: string[]): Promise<RunningServer> {
  reached();
  const server = await launchServer(extra);
  return server;
}

describe("TLS", () => {
  test("verified against the given CA; refused without it; skipVerify for development; server name checked", async () => {
    const ca = makeCA();
    const server = await started(["--tls-cert", ca.serverCert, "--tls-key", ca.serverKey]);
    try {
      const conn = await open({ tls: { ca: ca.caPem } }, server);
      expect(await scalar(conn, "SELECT 1")).toBe(1);
      expect(uri(server)).toBe(`chargewire://${server.host}`); // TLS is chargewire://'s default
      // Without the CA the certificate is unknown: a transport error, not retried.
      const started = Date.now();
      const err = await expectCode(open({}, server), ErrorCode.clientTransportError);
      expect(err.message).toMatch(/certificate|self.signed|issuer/i);
      expect(Date.now() - started).toBeLessThan(1500);
      const insecure = await open({ tls: { skipVerify: true } }, server);
      expect(await scalar(insecure, "SELECT 2")).toBe(2);
      await expectCode(
        open({ tls: { ca: ca.caPem, servername: "db.example.com" } }, server),
        ErrorCode.clientTransportError,
      );
      const named = await open({ tls: { ca: ca.caPem, servername: "localhost" } }, server);
      expect(await scalar(named, "SELECT 3")).toBe(3);
    } finally {
      await server.stop();
    }
  });

  test("mutual TLS: a client certificate is required, and accepted", async () => {
    const ca = makeCA();
    const server = await started([
      "--tls-cert",
      ca.serverCert,
      "--tls-key",
      ca.serverKey,
      "--tls-client-ca",
      ca.caFile,
    ]);
    try {
      const conn = await open({ tls: { ca: ca.caPem, cert: ca.clientCertPem, key: ca.clientKeyPem } }, server);
      expect(await scalar(conn, "SELECT 1")).toBe(1);
      await expectCode(open({ tls: { ca: ca.caPem } }, server), ErrorCode.clientTransportError);
    } finally {
      await server.stop();
    }
  });

  test("a split result over TLS stays in order", async () => {
    const ca = makeCA();
    const server = await started(["--tls-cert", ca.serverCert, "--tls-key", ca.serverKey]);
    try {
      const conn = await open({ tls: { ca: ca.caPem }, resultPartitions: 4 }, server);
      const values = numbers(await conn.query("SELECT i FROM range(1000000) t(i) ORDER BY i DESC"), "i");
      expect(values.length).toBe(1_000_000);
      expect(values.every((v, i) => v === 999_999 - i)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("tls and fetch cannot both be given", async () => {
    await expectCode(
      connect({ url: uri(), username: testUsername, password: shared.password, tls: {}, fetch }),
      ErrorCode.clientInvalidArgument,
    );
  });
});

describe("authentication", () => {
  test("a wrong password is invalid_credentials; the right one connects", async () => {
    reached();
    await expectCode(
      connect({ url: uri(), username: testUsername, password: "wrong", logger: quiet }),
      ErrorCode.invalidCredentials,
    );
    await expectCode(
      connect({ url: uri(), username: "nobody", password: shared.password, logger: quiet }),
      ErrorCode.invalidCredentials,
    );
    const conn = await open();
    expect(await scalar(conn, "SELECT 1")).toBe(1);
  });

  test("an access token issued elsewhere is used as is", async () => {
    const token = await rawToken(shared);
    const conn = await open({ username: undefined, password: undefined, token });
    expect(await scalar(conn, "SELECT 1")).toBe(1);
  });

  test("a grant the server does not offer is refused at connect", async () => {
    reached();
    const err = await expectCode(
      connect({ url: uri(), subjectToken: "an-oidc-token", logger: quiet }),
      ErrorCode.notImplemented,
    );
    expect(err.message).toContain("token_exchange");
  });

  test("credentials are checked before anything is sent", async () => {
    await expectCode(connect({ url: uri() } as never), ErrorCode.clientInvalidArgument);
    await expectCode(connect({ url: uri(), password: "x" }), ErrorCode.clientInvalidArgument); // no username
    await expectCode(
      connect({ url: uri(), username: "u", password: "p", token: "t" }),
      ErrorCode.clientInvalidArgument,
    );
    await expectCode(
      connect({ url: `chargewire://joe:secret@${shared.host}?tls=false`, username: "joe", password: "x" }),
      ErrorCode.clientInvalidArgument,
    );
  });

  test("an unreachable server is a transport error", async () => {
    const port = await freePort();
    await expectCode(
      connect({ url: `http://127.0.0.1:${port}`, username: "u", password: "p", maxAttempts: 1 }),
      ErrorCode.clientTransportError,
    );
  });

  test("something that is not a Chargewire server is a protocol error", async () => {
    const other = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"hello":"world"}');
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    try {
      const port = (other.address() as AddressInfo).port;
      const err = await expectCode(
        connect({ url: `http://127.0.0.1:${port}`, username: "u", password: "p" }),
        ErrorCode.clientProtocolError,
      );
      expect(err.message).toContain("does not describe a Chargewire server");
    } finally {
      other.close();
    }
  });

  test("bad URLs are refused; a wrapper can add its own scheme", async () => {
    for (const url of [
      "",
      "db.example.com:31337",
      "ftp://h:1",
      "chargewire://h:1?tls=maybe",
      "chargewire://h:1?color=blue",
      "chargewire://:1",
    ]) {
      await expectCode(connect({ url, username: "u", password: "p" }), ErrorCode.clientInvalidArgument);
    }
    reached();
    const conn = await connect({
      url: `hardcharger://${shared.host}?tls=false`,
      username: testUsername,
      password: shared.password,
      logger: quiet,
      schemes: { ...defaultSchemes, hardcharger: { tls: true, tlsParameter: true } },
    });
    expect(await scalar(conn, "SELECT 1")).toBe(1);
    await conn.close();
  });
});

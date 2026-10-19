// Licensed under the Apache License, Version 2.0.
//
// Client certificate sign-in (§4.4) against a real server: servers that verify client
// certificates and turn certificate sign-in on (--mtls-certificate-sign-in, with the test
// client's identity as an admin identity), which warp-duckdb and Hardcharger share.

import { tableFromArrays } from "apache-arrow";
import { Agent, fetch as undiciFetch } from "undici";
import { describe, expect, test } from "vitest";

import { type ConnectOptions, ErrorCode, connect } from "../../src/index.js";
import { type TestCA } from "./certs.js";
import { makeCA } from "./tls-ca.js";
import { type RunningServer, launchServer, serverName, testUsername } from "./harness.js";
import { expectCode, open, quiet, reached, scalar, uri } from "./helpers.js";

// The admin identity is written in another case: an e-mail identity matches ignoring ASCII
// case (§4.4's recommended rule, which both servers follow).
const adminIdentity = "Warp-Test-Client@Example.COM";

async function certificateServer(ca: TestCA, extra: string[] = []): Promise<RunningServer> {
  reached();
  return launchServer([
    "--tls-cert",
    ca.serverCert,
    "--tls-key",
    ca.serverKey,
    "--tls-client-ca",
    ca.caFile,
    "--mtls-certificate-sign-in",
    "--mtls-admin-identities",
    adminIdentity,
    ...extra,
  ]);
}

/** Options for a certificate sign-in with this certificate (the test client's by default). */
function certificate(ca: TestCA, cert = ca.clientCertPem, key = ca.clientKeyPem): Partial<ConnectOptions> {
  return {
    username: undefined,
    password: undefined,
    authType: "client_certificate",
    tls: { ca: ca.caPem, cert, key },
  };
}

/** A token from the client_certificate grant, got the way another tool would. */
async function certificateToken(server: RunningServer, ca: TestCA): Promise<string> {
  const agent = new Agent({ connect: { ca: ca.caPem, cert: ca.clientCertPem, key: ca.clientKeyPem } });
  try {
    const resp = await undiciFetch(`https://${server.host}/warp/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_certificate" }),
      dispatcher: agent,
    });
    const answer = (await resp.json()) as { access_token?: string };
    if (resp.status !== 200 || answer.access_token === undefined)
      throw new Error(`certificate sign-in: ${resp.status}`);
    return answer.access_token;
  } finally {
    await agent.close();
  }
}

describe("client certificate sign-in (§4.4)", () => {
  test("signs in without a password; a split result and an upload use the bound token", async () => {
    const ca = makeCA();
    const server = await certificateServer(ca);
    try {
      const conn = await open({ ...certificate(ca), resultPartitions: 4 }, server);
      expect(await scalar(conn, "SELECT 7")).toBe(7);
      if (serverName() === "Hardcharger") {
        const user = await conn.query("SELECT HARDCHARGER_USER() AS u");
        expect(user.getChild("u")!.get(0)).toBe(adminIdentity); // the configured spelling
      }
      // Every partition is read over a connection of its own, from the one dispatcher: each
      // presents the certificate, or the server answers certificate_mismatch.
      const stream = conn.stream("SELECT i FROM range(1000000) t(i) ORDER BY i DESC");
      const values: number[] = [];
      for await (const batch of stream) for (const v of batch.getChildAt(0)!) values.push(Number(v));
      expect(values.length).toBe(1_000_000);
      expect(values.every((v, i) => v === 999_999 - i)).toBe(true);
      if (conn.capabilities.has("result_partitions")) expect(await stream.partitions()).toBeGreaterThan(1);
      const rows = tableFromArrays({ v: Int32Array.from({ length: 100_000 }, (_, i) => i) });
      expect(await conn.ingest("mtls_upload", rows, { mode: "replace" })).toBe(100_000);
      expect(await scalar(conn, "SELECT count(*) FROM mtls_upload")).toBe(100_000);
    } finally {
      await server.stop();
    }
  });

  test("an identity the server does not know is unknown_certificate_identity", async () => {
    const ca = makeCA();
    const server = await certificateServer(ca);
    try {
      const stranger = ca.issueClient("stranger", "stranger@example.com");
      const err = await expectCode(
        open(certificate(ca, stranger.certPem, stranger.keyPem), server),
        ErrorCode.unknownCertificateIdentity,
      );
      expect(err.status).toBe(401);
      // The twin: the known identity, on the same server.
      expect(await scalar(await open(certificate(ca), server), "SELECT 1")).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("a bound token over another certificate is certificate_mismatch; over its own it works", async () => {
    const ca = makeCA();
    const server = await certificateServer(ca);
    try {
      const token = await certificateToken(server, ca);
      const stranger = ca.issueClient("stranger", "stranger@example.com");
      await expectCode(
        open(
          {
            username: undefined,
            password: undefined,
            token,
            tls: { ca: ca.caPem, cert: stranger.certPem, key: stranger.keyPem },
          },
          server,
        ),
        ErrorCode.certificateMismatch,
      );
      const own = await open(
        {
          username: undefined,
          password: undefined,
          token,
          tls: { ca: ca.caPem, cert: ca.clientCertPem, key: ca.clientKeyPem },
        },
        server,
      );
      expect(await scalar(own, "SELECT 8")).toBe(8);
    } finally {
      await server.stop();
    }
  });

  test("where certificates are optional, a grant without one is certificate_required", async () => {
    const ca = makeCA();
    const server = await certificateServer(ca, ["--mtls-require-client-cert=false"]);
    const noCertificate = new Agent({ connect: { ca: ca.caPem } });
    try {
      // A fetch of one's own, presenting no certificate: the client lets it try.
      const fetchWithoutCertificate = ((input: RequestInfo | URL, init?: RequestInit) =>
        undiciFetch(input as string, { ...(init as object), dispatcher: noCertificate })) as unknown as typeof fetch;
      reached();
      await expectCode(
        connect({ url: uri(server), authType: "client_certificate", fetch: fetchWithoutCertificate, logger: quiet }),
        ErrorCode.certificateRequired,
      );
      // The twins: the certificate signs in, and a password works without one.
      expect(await scalar(await open(certificate(ca), server), "SELECT 2")).toBe(2);
      expect(await scalar(await open({ fetch: fetchWithoutCertificate }, server), "SELECT 3")).toBe(3);
    } finally {
      await noCertificate.close();
      await server.stop();
    }
  });

  test("with identity match, a password sign-in over another identity's certificate is certificate_identity_mismatch", async () => {
    const ca = makeCA();
    const server = await certificateServer(ca, ["--mtls-require-client-cert=false", "--mtls-require-identity-match"]);
    try {
      // The admin user (warp_test) signs in with its password over the test client's certificate.
      const err = await expectCode(
        open({ tls: { ca: ca.caPem, cert: ca.clientCertPem, key: ca.clientKeyPem } }, server),
        ErrorCode.certificateIdentityMismatch,
      );
      expect(err.status).toBe(401);
      // The twin: the same password without a certificate.
      expect(await scalar(await open({ tls: { ca: ca.caPem } }, server), "SELECT 4")).toBe(4);
    } finally {
      await server.stop();
    }
  });

  test("a server that verifies certificates but has certificate sign-in off is refused before the grant", async () => {
    const ca = makeCA();
    reached();
    const server = await launchServer([
      "--tls-cert",
      ca.serverCert,
      "--tls-key",
      ca.serverKey,
      "--tls-client-ca",
      ca.caFile,
    ]);
    try {
      const err = await expectCode(open(certificate(ca), server), ErrorCode.notImplemented);
      expect(err.message).toContain("mtls_identity");
      // The twin: a password sign-in over the same certificate.
      const conn = await open(
        { username: testUsername, tls: { ca: ca.caPem, cert: ca.clientCertPem, key: ca.clientKeyPem } },
        server,
      );
      expect(await scalar(conn, "SELECT 5")).toBe(5);
    } finally {
      await server.stop();
    }
  });
});

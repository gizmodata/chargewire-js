// Starts a Warp SQL server with TLS and certificate sign-in that allows the example page's
// origin, and hands the tests its address and the client certificate (throwaway test PEMs)
// through the environment. Certificates are optional at the handshake: browsers send CORS
// preflights without credentials (spec §9.5).
import { clientEmail, makeCAWithCleanup } from "../live/certs.ts";
import { launchServer } from "../live/harness.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const port = Number(process.env["WARP_SQL_JS_EXAMPLE_PORT"] ?? 5173);
  const ca = makeCAWithCleanup();
  const server = await launchServer([
    "--tls-cert",
    ca.serverCert,
    "--tls-key",
    ca.serverKey,
    "--tls-client-ca",
    ca.caFile,
    "--mtls-require-client-cert=false",
    "--mtls-certificate-sign-in",
    "--mtls-admin-identities",
    clientEmail,
    "--cors-origin",
    `http://localhost:${port}`,
  ]);
  process.env["WARP_SQL_JS_BROWSER_MTLS"] = JSON.stringify({
    host: server.host,
    certPem: ca.clientCertPem,
    keyPem: ca.clientKeyPem,
  });
  return async () => {
    await server.stop();
    ca.remove();
  };
}

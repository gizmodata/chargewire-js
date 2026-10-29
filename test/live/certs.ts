// Licensed under the Apache License, Version 2.0.
//
// Throwaway certificates for the TLS tests, made with the openssl command: a CA, a server
// certificate for 127.0.0.1 and localhost, and a client certificate for mutual TLS whose
// identity (an e-mail SAN, for certificate sign-in, §4.4) is clientEmail. issueClient makes
// more client certificates from the same CA.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No vitest import: the browser tests' global setup (Playwright) makes certificates too.

/** The identity (rfc822Name SAN) of makeCA's client certificate. */
export const clientEmail = "chargewire-test-client@example.com";

export interface ClientCertificate {
  certPem: string;
  keyPem: string;
}

export interface TestCA {
  caPem: string;
  caFile: string;
  serverCert: string;
  serverKey: string;
  clientCertPem: string;
  clientKeyPem: string;
  /** Another client certificate from this CA, with this e-mail identity. */
  issueClient(cn: string, email: string): ClientCertificate;
}

function openssl(dir: string, ...args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

/** A CA in a fresh temporary directory, which `remove` deletes. */
export function makeCAWithCleanup(): TestCA & { remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "chargewire-js-tls-"));
  return { ...makeCAIn(dir), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCAIn(dir: string): TestCA {
  const days = ["-days", "2"];
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  openssl(
    dir,
    "req",
    "-x509",
    ...ec,
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-subj",
    "/CN=chargewire-js test CA",
    ...days,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,digitalSignature",
  );
  const issue = (name: string, cn: string, ext: string): void => {
    writeFileSync(join(dir, `${name}.ext`), `keyUsage=critical,digitalSignature\n${ext}\n`);
    openssl(dir, "req", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`);
    openssl(
      dir,
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.pem`,
      "-extfile",
      `${name}.ext`,
      ...days,
    );
  };
  issue("server", "localhost", "extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost");
  issue("client", "chargewire_test", `extendedKeyUsage=clientAuth\nsubjectAltName=email:${clientEmail}`);
  let issued = 0;
  return {
    caPem: readFileSync(join(dir, "ca.pem"), "utf8"),
    caFile: join(dir, "ca.pem"),
    serverCert: join(dir, "server.pem"),
    serverKey: join(dir, "server.key"),
    clientCertPem: readFileSync(join(dir, "client.pem"), "utf8"),
    clientKeyPem: readFileSync(join(dir, "client.key"), "utf8"),
    issueClient(cn: string, email: string): ClientCertificate {
      const name = `client${++issued}`;
      issue(name, cn, `extendedKeyUsage=clientAuth\nsubjectAltName=email:${email}`);
      return {
        certPem: readFileSync(join(dir, `${name}.pem`), "utf8"),
        keyPem: readFileSync(join(dir, `${name}.key`), "utf8"),
      };
    },
  };
}

// Licensed under the Apache License, Version 2.0.
//
// Throwaway certificates for the TLS tests, made with the openssl command: a CA, a server
// certificate for 127.0.0.1 and localhost, and a client certificate for mutual TLS.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vitest";

export interface TestCA {
  caPem: string;
  caFile: string;
  serverCert: string;
  serverKey: string;
  clientCertPem: string;
  clientKeyPem: string;
}

function openssl(dir: string, ...args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

export function makeCA(): TestCA {
  const dir = mkdtempSync(join(tmpdir(), "warp-sql-js-tls-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
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
    "/CN=warp-sql-js test CA",
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
  issue("client", "warp_test", "extendedKeyUsage=clientAuth");
  return {
    caPem: readFileSync(join(dir, "ca.pem"), "utf8"),
    caFile: join(dir, "ca.pem"),
    serverCert: join(dir, "server.pem"),
    serverKey: join(dir, "server.key"),
    clientCertPem: readFileSync(join(dir, "client.pem"), "utf8"),
    clientKeyPem: readFileSync(join(dir, "client.key"), "utf8"),
  };
}

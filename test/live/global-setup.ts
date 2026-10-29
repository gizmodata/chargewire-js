// Licensed under the Apache License, Version 2.0.
//
// Starts the shared server once. Without CHARGEWIRE_JS_TEST_SERVER_BINARY the run fails:
// these tests never skip. A run in which no test reached a server fails too.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestProject } from "vitest/node";

import { type ServerInfo, launchServer } from "./harness.js";

declare module "vitest" {
  export interface ProvidedContext {
    server: ServerInfo;
    counterFile: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(tmpdir(), "chargewire-js-live-"));
  const counterFile = join(dir, "reached");
  writeFileSync(counterFile, "");
  const server = await launchServer();
  project.provide("server", { host: server.host, password: server.password, scheme: server.scheme, pid: server.pid });
  project.provide("counterFile", counterFile);
  return async () => {
    await server.stop();
    const reached = readFileSync(counterFile, "utf8").length;
    rmSync(dir, { recursive: true, force: true });
    if (reached === 0) throw new Error("FAIL: no live test reached the server");
  };
}

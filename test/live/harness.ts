// Licensed under the Apache License, Version 2.0.
//
// Starts Chargewire servers for the live tests. The binary is CHARGEWIRE_JS_TEST_SERVER_BINARY,
// a server with chargewire-duckdb's interface (--host, --port, --username, --tls-cert,
// --tls-key, --tls-client-ca, --cors-origin, password in CHARGEWIRE_DUCKDB_PASSWORD). For another
// server, name its password variable, user-name flag, client-CA flag, CORS flag and name:
//
//   CHARGEWIRE_JS_TEST_SERVER_PASSWORD_ENV   (Hardcharger: HARDCHARGER_ADMIN_PASSWORD)
//   CHARGEWIRE_JS_TEST_SERVER_USERNAME_FLAG  (Hardcharger: --admin-username)
//   CHARGEWIRE_JS_TEST_SERVER_MTLS_FLAG      (Hardcharger: --mtls-ca-cert)
//   CHARGEWIRE_JS_TEST_SERVER_CORS_FLAG      (Hardcharger: --cors-origins)
//   CHARGEWIRE_JS_TEST_SERVER_NAME           (Hardcharger: Hardcharger)
//
// Only these CHARGEWIRE_JS_TEST_* variables are read: never a generic name like
// GIZMOSQL_PASSWORD that a developer's shell may export for a real server.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

export const binaryEnv = "CHARGEWIRE_JS_TEST_SERVER_BINARY";
export const testUsername = "chargewire_test";

export function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

export const serverName = (): string => env("CHARGEWIRE_JS_TEST_SERVER_NAME", "chargewire-duckdb");

/** What a test needs to reach a server. */
export interface ServerInfo {
  host: string; // 127.0.0.1:port
  password: string;
  scheme: "http" | "https";
  pid: number;
}

export interface RunningServer extends ServerInfo {
  stop(): Promise<void>;
  log(): string;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

/**
 * Launches the binary with a fresh password that contains ':' and '@' (credentials travel
 * as JSON fields, so nothing may split them, §4.1). `extra` takes chargewire-duckdb's flag
 * names; --tls-client-ca and --cors-origin are renamed to the server's own. `{port}` in an
 * argument becomes the server's port; `extraEnv` adds environment variables.
 */
export async function launchServer(
  extra: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<RunningServer> {
  const binary = process.env[binaryEnv];
  if (binary === undefined || binary === "") {
    throw new Error(
      `set ${binaryEnv} to a Chargewire server binary (chargewire-duckdb or Hardcharger) to run the live tests`,
    );
  }
  const port = await freePort();
  const password = randomBytes(9).toString("hex") + ":p@ss:word";
  let scheme: "http" | "https" = "http";
  const mtls = extra.includes("--tls-client-ca");
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    env("CHARGEWIRE_JS_TEST_SERVER_USERNAME_FLAG", "--username"),
    testUsername,
  ];
  for (const arg of extra) {
    if (arg === "--tls-cert") scheme = "https";
    if (arg === "--tls-client-ca") args.push(env("CHARGEWIRE_JS_TEST_SERVER_MTLS_FLAG", arg));
    else if (arg === "--cors-origin") args.push(env("CHARGEWIRE_JS_TEST_SERVER_CORS_FLAG", arg));
    else args.push(arg.replaceAll("{port}", String(port)));
  }
  const output: string[] = [];
  const child: ChildProcess = spawn(binary, args, {
    env: {
      ...process.env,
      ...extraEnv,
      [env("CHARGEWIRE_JS_TEST_SERVER_PASSWORD_ENV", "CHARGEWIRE_DUCKDB_PASSWORD")]: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const host = `127.0.0.1:${port}`;
  const server: RunningServer = {
    host,
    password,
    scheme,
    pid: child.pid ?? 0,
    log: () => output.join(""),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // The first SIGTERM drains, the second stops at once.
      child.kill("SIGTERM");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await exited;
      clearTimeout(timer);
    },
  };
  try {
    await waitUp(server, child, mtls);
  } catch (err) {
    await server.stop();
    throw new Error(`${String(err)}\nserver output:\n${server.log()}`, { cause: err });
  }
  return server;
}

const insecure = new Agent({ connect: { rejectUnauthorized: false } });

async function waitUp(server: RunningServer, child: ChildProcess, mtls: boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited with code ${child.exitCode}`);
    try {
      const resp = await undiciFetch(`${server.scheme}://${server.host}/chargewire`, {
        dispatcher: insecure,
        signal: AbortSignal.timeout(2000),
      });
      await resp.body?.cancel();
      if (resp.status === 200) return;
      last = `GET /chargewire: ${resp.status}`;
    } catch (err) {
      // A server that requires client certificates refuses this handshake: anything but a
      // refused connection means it is up.
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (mtls && code !== undefined && code !== "ECONNREFUSED") return;
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no Chargewire server answered at ${server.host} within 20s: ${String(last)}`);
}

/** A token for raw protocol calls (killing sessions behind the client's back, say). */
export async function rawToken(server: ServerInfo): Promise<string> {
  const resp = await undiciFetch(`${server.scheme}://${server.host}/chargewire/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "password", username: testUsername, password: server.password }),
    dispatcher: insecure,
  });
  const answer = (await resp.json()) as { access_token: string };
  return answer.access_token;
}

/** Deletes a handle behind the client's back (`/v1/sessions/…`), as an eviction or a restart would. */
export async function rawDelete(server: ServerInfo, path: string): Promise<void> {
  const token = await rawToken(server);
  const resp = await undiciFetch(`${server.scheme}://${server.host}/chargewire${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    dispatcher: insecure,
  });
  await resp.body?.cancel();
  if (resp.status !== 204) throw new Error(`DELETE ${path}: HTTP ${resp.status}`);
}

/** Ends a session behind the client's back, as an idle eviction or a restart would. */
export async function killSession(server: ServerInfo, sessionId: string): Promise<void> {
  await rawDelete(server, `/v1/sessions/${sessionId}`);
}

export const randomName = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

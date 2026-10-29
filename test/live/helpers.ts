// Licensed under the Apache License, Version 2.0.

import { appendFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import type { Table } from "apache-arrow";
import { expect, inject, onTestFinished } from "vitest";

import { type ConnectOptions, type Connection, ChargewireError, connect } from "../../src/index.js";
import { type ServerInfo, testUsername } from "./harness.js";

export const shared: ServerInfo = inject("server");

/** Counts a test that reached a server, so a run where none did fails. */
export function reached(): void {
  appendFileSync(inject("counterFile"), "x");
}

export function uri(info: ServerInfo = shared): string {
  return info.scheme === "https" ? `chargewire://${info.host}` : `chargewire://${info.host}?tls=false`;
}

export const quiet = { warn: () => {} };

/** Opens a connection that the caller closes. */
export async function openUnmanaged(
  options: Partial<ConnectOptions> = {},
  info: ServerInfo = shared,
): Promise<Connection> {
  reached();
  return connect({
    url: uri(info),
    username: testUsername,
    password: info.password,
    logger: quiet,
    ...options,
  } as ConnectOptions);
}

/** Opens a connection to a server (the shared one unless given); it closes when the test ends. */
export async function open(options: Partial<ConnectOptions> = {}, info: ServerInfo = shared): Promise<Connection> {
  const conn = await openUnmanaged(options, info);
  onTestFinished(async () => {
    await conn.close().catch(() => {});
  });
  return conn;
}

/** Asserts that `work` fails with a ChargewireError of `code`, and returns it. */
export async function expectCode(
  work: Promise<unknown> | (() => Promise<unknown>),
  code: string,
): Promise<ChargewireError> {
  let caught: unknown;
  try {
    await (typeof work === "function" ? work() : work);
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected an error").toBeInstanceOf(ChargewireError);
  expect((caught as ChargewireError).code, (caught as Error).message).toBe(code);
  return caught as ChargewireError;
}

/** Number values of a column (bigints converted). */
export function numbers(table: Table, column: string | number = 0): number[] {
  const vector = typeof column === "number" ? table.getChildAt(column) : table.getChild(column);
  if (vector === null) throw new Error(`no column ${column}`);
  return Array.from(vector, (v) => (v === null ? Number.NaN : Number(v)));
}

export async function scalar(conn: Connection, sql: string): Promise<number> {
  const table = await conn.query(sql);
  return Number(table.getChildAt(0)!.get(0));
}

/** The session answers a trivial query soon: proof a statement the test stopped really stopped. */
export async function expectSessionUsable(conn: Connection, withinMs = 15_000): Promise<void> {
  const started = Date.now();
  expect(await scalar(conn, "SELECT 42")).toBe(42);
  expect(Date.now() - started).toBeLessThan(withinMs);
}

/** Resolves to "pending" if the promise has not settled within `ms`. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const longQuery = "SELECT sum(a.range * b.range) FROM range(100000000) a, range(100000) b";
export const streamingQuery = "SELECT i FROM range(100000000000) t(i)";
export const bigQuery = "SELECT i, i * 2 AS j FROM range(1000000) t(i)";

export function expectBig(table: Table): void {
  const values = numbers(table, "i");
  expect(values.length).toBe(1_000_000);
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== i) throw new Error(`row ${i} = ${values[i]}: rows lost, repeated or reordered`);
  }
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** The first 64 KiB of the request body, as text. */
  body: string;
  /** The answer's headers, once it has arrived. */
  answerHeaders?: Record<string, string | string[] | undefined>;
  /** The answer's body as it reached the client, when the proxy keeps answers. */
  answer?: Buffer[];
}

export interface FaultRule {
  match: (r: RecordedRequest) => boolean;
  /** Cut the answer's body after this many bytes; 0 drops the whole answer after the server answered. */
  cutAfter: number;
  times: number;
}

/**
 * Sits between the client and a server, records every request, and breaks the exchanges
 * a rule picks, the way a real network does.
 */
export class FaultProxy {
  readonly seen: RecordedRequest[] = [];
  /** TCP connections the client opened to the proxy. */
  connections = 0;
  /** Keep every answer's body in `answer` (for small results). */
  keepAnswers = false;
  readonly #rules: FaultRule[] = [];
  readonly #server = createServer((req, res) => this.#handle(req, res));
  readonly #target: ServerInfo;

  private constructor(target: ServerInfo) {
    this.#target = target;
  }

  static async start(target: ServerInfo = shared): Promise<FaultProxy> {
    if (target.scheme !== "http") throw new Error("the fault proxy speaks plain HTTP to the server");
    const proxy = new FaultProxy(target);
    proxy.#server.on("connection", () => proxy.connections++);
    await new Promise<void>((resolve) => proxy.#server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => proxy.close());
    return proxy;
  }

  get info(): ServerInfo {
    const port = (this.#server.address() as AddressInfo).port;
    return { ...this.#target, host: `127.0.0.1:${port}` };
  }

  add(rule: FaultRule): void {
    this.#rules.push(rule);
  }

  requests(match: (r: RecordedRequest) => boolean): RecordedRequest[] {
    return this.seen.filter(match);
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #take(r: RecordedRequest): FaultRule | undefined {
    const rule = this.#rules.find((x) => x.times > 0 && x.match(r));
    if (rule) rule.times--;
    return rule;
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://proxy");
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: { ...req.headers },
      body: "",
    };
    req.on("data", (chunk: Buffer) => {
      if (recorded.body.length < 65536)
        recorded.body += chunk.subarray(0, 65536 - recorded.body.length).toString("latin1");
    });
    this.seen.push(recorded);
    const [hostname, port] = this.#target.host.split(":");
    const upstream = httpRequest(
      {
        hostname,
        port: Number(port),
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: this.#target.host },
      },
      (answer) => {
        recorded.answerHeaders = { ...answer.headers };
        if (this.keepAnswers) recorded.answer = [];
        const rule = this.#take(recorded);
        if (rule !== undefined && rule.cutAfter === 0) {
          // A lost answer: the server did the work, the client hears nothing.
          answer.resume();
          answer.on("end", () => res.socket?.destroy());
          return;
        }
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        let left = rule?.cutAfter ?? Number.POSITIVE_INFINITY;
        answer.on("data", (chunk: Buffer) => {
          if (left <= 0) return;
          if (chunk.byteLength >= left) {
            // Cut once what came before has reached the client.
            res.write(chunk.subarray(0, left), () => res.socket?.destroy());
            left = 0;
            answer.destroy();
            return;
          }
          left -= chunk.byteLength;
          recorded.answer?.push(chunk);
          if (!res.write(chunk)) {
            answer.pause();
            res.once("drain", () => answer.resume());
          }
        });
        answer.on("end", () => res.end());
        answer.on("error", () => res.socket?.destroy());
      },
    );
    upstream.on("error", () => res.socket?.destroy());
    req.pipe(upstream);
    res.on("close", () => upstream.destroy());
  }
}

export const isPost = (suffix: string) => (r: RecordedRequest) => r.method === "POST" && r.path.endsWith(suffix);
export const isSubmitOf = (text: string) => (r: RecordedRequest) => isPost("/statements")(r) && r.body.includes(text);
export const isResultFetch = (r: RecordedRequest) => r.method === "GET" && r.path.endsWith("/result");

/** Whether the server can split results (§6.10). */
export async function splits(conn: Connection): Promise<boolean> {
  return conn.capabilities.has("result_partitions");
}

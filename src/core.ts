// Licensed under the Apache License, Version 2.0.

import { type IpcCodec, type IpcCompression, chooseCodec, enableCodec, farLinkMs } from "./compression.js";
import { ErrorCode, WarpSqlError } from "./errors.js";
import { type HttpClient, type Logger, discard } from "./http.js";
import type { Platform } from "./platform/types.js";
import type { DiscoveryDocument } from "./protocol.js";
import type { Session } from "./session.js";

/** How statements run unless a call says otherwise. */
export interface StatementSettings {
  /** Submit, poll, then read a retained, resumable result (§6.1, §6.3). */
  async: boolean;
  /** Ask the server to keep (or not keep) results for re-reading and resuming (§6.5); undefined: server's choice. */
  retainResult: boolean | undefined;
  /** Milliseconds before the server cancels the statement (§6.9). */
  statementTimeoutMs: number | undefined;
  /** JSON object recorded with the statement (Warp-Query-Tag), already serialized. */
  queryTag: string | undefined;
  /** The Arrow buffer compression asked for (`ipcCompression`). */
  ipcCompression: IpcCompression;
  /** The codec results are asked in (Warp-IPC-Compression, §8.2), chosen from `ipcCompression` once the server is known; undefined: none. */
  ipcCodec: IpcCodec | undefined;
  /** Read up to this many partitions of a result at once (§6.10); 1: one stream. */
  resultPartitions: number;
  /** `any` lets a split result come back in any row order. */
  resultOrder: "preserve" | "any";
}

/** A stream the connection may have to read ahead before the session can do something else. */
export interface OpenStream {
  bufferRest(limit: number): Promise<void>;
}

/** What every part of a connection shares. */
export class Core {
  readonly http: HttpClient;
  readonly session: Session;
  readonly discovery: DiscoveryDocument;
  readonly capabilities: ReadonlySet<string>;
  readonly platform: Platform;
  readonly settings: StatementSettings;
  readonly resultBufferBytes: number;
  readonly logger: Logger;
  /** Statements of this connection running or being read. */
  running = 0;
  readonly openStreams = new Set<OpenStream>();
  closed = false;

  constructor(init: {
    http: HttpClient;
    session: Session;
    discovery: DiscoveryDocument;
    platform: Platform;
    settings: StatementSettings;
    resultBufferBytes: number;
    discoveryRttMs: number;
  }) {
    this.http = init.http;
    this.session = init.session;
    this.discovery = init.discovery;
    this.capabilities = new Set(init.discovery.capabilities ?? []);
    this.platform = init.platform;
    this.settings = init.settings;
    this.resultBufferBytes = init.resultBufferBytes;
    this.logger = init.http.logger;
    this.#discoveryRttMs = init.discoveryRttMs;
  }

  readonly #discoveryRttMs: number;
  #linkRtt: Promise<number> | undefined;

  /**
   * About one network round trip to the server, for `auto` compression: the time the
   * discovery request took to answer. That time includes opening the connection (TCP and
   * TLS handshakes, a round trip or more each), so when it looks like a far link, one
   * more discovery request on the open connection is timed and the shorter one counts.
   */
  linkRttMs(): Promise<number> {
    this.#linkRtt ??= (async () => {
      const first = this.#discoveryRttMs;
      if (first < farLinkMs) return first;
      try {
        const start = performance.now();
        const resp = await this.http.request({
          method: "GET",
          path: "",
          idempotent: true,
          anonymous: true,
          signal: AbortSignal.timeout(5_000),
        });
        const rtt = performance.now() - start;
        await discard(resp);
        return Math.min(first, rtt);
      } catch {
        return first;
      }
    })();
    return this.#linkRtt;
  }

  /** Chooses the codec for `settings` (§8.2) and loads its decoder. */
  async resolveCodec(settings: StatementSettings): Promise<void> {
    const rtt = settings.ipcCompression === "auto" ? await this.linkRttMs() : 0;
    settings.ipcCodec = chooseCodec(settings.ipcCompression, (c) => this.has(c), rtt);
    if (settings.ipcCodec !== undefined) await enableCodec(settings.ipcCodec);
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  /** Fails unless the server lists `capability`: a client must not use what a server does not offer (§3.1). */
  require(capability: string, what: string): void {
    if (!this.has(capability)) {
      throw new WarpSqlError({
        code: ErrorCode.notImplemented,
        message: `${what} needs the server capability ${capability}, which this server does not list`,
      });
    }
  }

  checkOpen(): void {
    if (this.closed) throw new WarpSqlError({ code: ErrorCode.connectionClosed, message: "the connection is closed" });
  }

  /** Runs cleanup off the caller's path; its failure is only logged. */
  background(what: string, task: () => Promise<unknown>): void {
    task().catch((err: unknown) => this.logger.debug?.(`background ${what} failed`, { error: String(err) }));
  }

  /**
   * Before the session does something else, reads what open streams still have into
   * memory: a server may hold other work on a session until a streaming result has been
   * read, which would wait forever on a stream the application reads later.
   */
  async settle(except?: OpenStream): Promise<void> {
    for (const stream of [...this.openStreams]) {
      if (stream !== except) await stream.bufferRest(this.resultBufferBytes);
    }
  }
}

// Licensed under the Apache License, Version 2.0.

import { ErrorCode, WarpSqlError } from "./errors.js";
import type { HttpClient, Logger } from "./http.js";
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
  /** Accept ZSTD-compressed Arrow buffers (§8.2). */
  zstd: boolean;
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
  }) {
    this.http = init.http;
    this.session = init.session;
    this.discovery = init.discovery;
    this.capabilities = new Set(init.discovery.capabilities ?? []);
    this.platform = init.platform;
    this.settings = init.settings;
    this.resultBufferBytes = init.resultBufferBytes;
    this.logger = init.http.logger;
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
    if (this.closed)
      throw new WarpSqlError({ code: ErrorCode.clientConnectionClosed, message: "the connection is closed" });
  }

  /** Runs cleanup off the caller's path; its failure is only logged. */
  /** Work started off the caller's path (statement deletes) that close() waits for. */
  readonly pending = new Set<Promise<unknown>>();

  background(what: string, task: () => Promise<unknown>): void {
    const run = task().catch((err: unknown) =>
      this.logger.debug?.(`background ${what} failed`, { error: String(err) }),
    );
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
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

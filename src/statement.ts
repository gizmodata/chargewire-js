// Licensed under the Apache License, Version 2.0.

import { Schema } from "apache-arrow";

import type { Core, StatementSettings } from "./core.js";
import { ErrorCode, WarpSqlError, problemError, protocolError } from "./errors.js";
import {
  type HttpRequest,
  type RequestBody,
  abortError,
  decodeJSON,
  discard,
  mediaTypeArrow,
  newIdempotencyKey,
  sleep,
} from "./http.js";
import { Capability, type StatementDocument, isTerminal } from "./protocol.js";
import { type BatchSource, PartReader, PartitionedReader, SequentialReader, isArrowResponse } from "./result.js";
import { sessionPath } from "./session.js";

/** How long a status request may wait on the server (long poll, §6.3), in seconds. */
export const longPollS = 15;
/** The most partitions a client may ask for (§6.10). */
export const maxResultPartitions = 256;

/** The error inside a failed or cancelled statement document (§6.2). */
export function statementError(doc: StatementDocument): WarpSqlError {
  const cancelReason = doc.cancel_reason;
  if (doc.error !== undefined && doc.error !== null) {
    return problemError(doc.error, { statementId: doc.statement_id, cancelReason });
  }
  const code =
    doc.state === "cancelled"
      ? cancelReason === "timeout"
        ? ErrorCode.statementTimeout
        : ErrorCode.statementCancelled
      : ErrorCode.executionError;
  return new WarpSqlError({
    code,
    message: `statement ${doc.statement_id} ${doc.state}`,
    statementId: doc.statement_id,
    cancelReason,
  });
}

/** A prepared statement in the session that prepared it. */
export interface PreparedRef {
  sessionId: string;
  preparedId: string;
}

/**
 * One run of a statement, from its submit (§6.1) or prepared execute (§7.2) until its
 * result has been read or abandoned. It keeps the request's body and Idempotency-Key, so
 * the same request can be sent again to learn the statement it created (§6.7), and owns
 * the AbortController that stops every request of the run.
 */
export class Execution {
  readonly core: Core;
  readonly settings: StatementSettings;
  readonly key = newIdempotencyKey();
  readonly body: RequestBody;
  readonly prepared: PreparedRef | undefined;
  /** The session the request went to. */
  sessionId: string | undefined;
  statementId: string | undefined;
  /** The request was handed to fetch, so the server may have the statement even without an answer. */
  sent = false;
  /** The application cancelled the statement. */
  cancelled = false;
  readonly #controller = new AbortController();
  readonly #userSignal: AbortSignal | undefined;
  readonly #onAbort: (() => void) | undefined;
  #finished = false;
  #freed = false;
  #stopping: Promise<void> | undefined;

  constructor(
    core: Core,
    settings: StatementSettings,
    body: RequestBody,
    prepared: PreparedRef | undefined,
    signal: AbortSignal | undefined,
  ) {
    core.checkOpen();
    this.core = core;
    this.settings = settings;
    this.body = body;
    this.prepared = prepared;
    this.#userSignal = signal;
    core.running++;
    if (signal !== undefined) {
      if (signal.aborted) {
        this.cancelled = true;
        this.#controller.abort(signal.reason);
      } else {
        this.#onAbort = () => void this.cancel(signal.reason);
        signal.addEventListener("abort", this.#onAbort, { once: true });
      }
    }
  }

  /** Aborts every request of this run when the statement is cancelled. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The error for a cancelled run. */
  cancelledError(signal: AbortSignal = this.signal): WarpSqlError {
    const source = this.#userSignal?.aborted ? this.#userSignal : signal.aborted ? signal : this.signal;
    if (!source.aborted) {
      return new WarpSqlError({
        code: ErrorCode.statementCancelled,
        message: "the statement was cancelled",
        cancelReason: "client",
        statementId: this.statementId,
      });
    }
    return abortError(source, this.statementId);
  }

  #path(sessionId: string): string {
    if (this.prepared !== undefined) {
      return `${sessionPath(this.prepared.sessionId)}/prepared/${encodeURIComponent(this.prepared.preparedId)}/execute`;
    }
    return `${sessionPath(sessionId)}/statements`;
  }

  #request(sessionId: string, mode: { arrow: boolean; async: boolean }, signal: AbortSignal): HttpRequest {
    const s = this.settings;
    const headers: Record<string, string> = { "Idempotency-Key": this.key };
    if (mode.arrow) headers["Accept"] = mediaTypeArrow;
    if (mode.async) headers["Prefer"] = "respond-async";
    else if (!mode.arrow) headers["Prefer"] = `wait=${longPollS}`;
    if (s.retainResult !== undefined) headers["Warp-Retain-Result"] = String(s.retainResult);
    if (s.statementTimeoutMs !== undefined && s.statementTimeoutMs > 0) {
      headers["Warp-Statement-Timeout"] = String(Math.max(1, Math.round(s.statementTimeoutMs)));
    }
    if (s.queryTag !== undefined) headers["Warp-Query-Tag"] = s.queryTag;
    if (s.ipcCodec !== undefined) headers["Warp-IPC-Compression"] = s.ipcCodec;
    if (s.resultPartitions > 1 && this.core.has(Capability.resultPartitions)) {
      headers["Warp-Result-Partitions"] = String(s.resultPartitions);
      if (s.resultOrder === "any") headers["Warp-Result-Order"] = "any";
    }
    return {
      method: "POST",
      path: this.#path(sessionId),
      headers,
      body: this.body,
      idempotent: true,
      signal,
      onSend: () => {
        this.sent = true;
      },
    };
  }

  /** Sends the submission. The answer is an Arrow stream (streamed path) or a statement document. */
  async submit(mode: { arrow: boolean; async: boolean }): Promise<Response> {
    const session = this.core.session;
    if (this.prepared !== undefined) {
      this.sessionId = this.prepared.sessionId;
      return session.doHandle(this.sessionId, "prepared statement", this.#request(this.sessionId, mode, this.signal));
    }
    return session.do("statement", "", (id) => {
      this.sessionId = id;
      return this.#request(id, mode, this.signal);
    });
  }

  /** Sends the submission again with the same Idempotency-Key, to learn its statement without running it twice (§6.7). */
  async #recall(signal: AbortSignal): Promise<string | undefined> {
    if (this.body.stream !== undefined || this.sessionId === undefined) return undefined;
    const doc = await this.core.http.json<StatementDocument>(
      this.#request(this.sessionId, { arrow: false, async: true }, signal),
    );
    return typeof doc.statement_id === "string" ? doc.statement_id : undefined;
  }

  #statementPath(): string {
    return `${sessionPath(this.sessionId!)}/statements/${encodeURIComponent(this.statementId!)}`;
  }

  /** Reads the statement document (§6.3); a positive wait long-polls. */
  async status(waitS: number, signal: AbortSignal = this.signal): Promise<StatementDocument> {
    const headers: Record<string, string> = {};
    if (waitS > 0 && this.core.has(Capability.longPoll)) headers["Prefer"] = `wait=${waitS}`;
    const resp = await this.core.session.doHandle(this.sessionId!, "statement", {
      method: "GET",
      path: this.#statementPath(),
      headers,
      idempotent: true,
      signal,
    });
    return decodeStatement(resp);
  }

  /** Waits until the statement reaches a final state. */
  async waitDone(doc: StatementDocument): Promise<StatementDocument> {
    let pause = 50;
    while (!isTerminal(doc.state)) {
      if (!this.core.has(Capability.longPoll)) {
        await sleep(pause, this.signal);
        pause = Math.min(pause * 2, 1000);
      }
      doc = await this.status(longPollS);
    }
    return doc;
  }

  /** Opens a partition of the result (§6.4). */
  async result(rr: {
    partition: number;
    fromBatch: number;
    location: URL | undefined;
    signal: AbortSignal;
  }): Promise<Response> {
    const query: Record<string, string> = {};
    if (rr.partition !== 0) query["partition"] = String(rr.partition);
    if (rr.fromBatch !== 0) query["from_batch"] = String(rr.fromBatch);
    const headers: Record<string, string> = { Accept: mediaTypeArrow };
    if (this.settings.ipcCodec !== undefined) headers["Warp-IPC-Compression"] = this.settings.ipcCodec;
    return this.core.session.doHandle(this.sessionId!, "result", {
      method: "GET",
      path: `${this.#statementPath()}/result`,
      query,
      headers,
      idempotent: true,
      baseUrl: rr.location,
      signal: rr.signal,
    });
  }

  /**
   * Cancels the statement on the server (§6.8) and stops waiting for it. Without its id
   * (its answer has not arrived) it cancels the session's work when this is the
   * connection's only statement running; otherwise it learns the id by sending the same
   * request again with its Idempotency-Key, which does not run it twice.
   */
  async cancel(reason?: unknown): Promise<void> {
    if (this.#finished) return;
    this.cancelled = true;
    this.#stopping ??= this.#stopOnServer().catch((err: unknown) =>
      this.core.logger.debug?.("cancelling on the server failed", { error: String(err) }),
    );
    await this.#stopping;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(
        reason ??
          new WarpSqlError({
            code: ErrorCode.statementCancelled,
            message: "the statement was cancelled",
            cancelReason: "client",
          }),
      );
    }
  }

  async #stopOnServer(): Promise<void> {
    const signal = AbortSignal.timeout(10_000);
    const http = this.core.http;
    if (this.statementId === undefined) {
      if (!this.sent || this.sessionId === undefined) return;
      if (this.core.running === 1) {
        try {
          await http.void({ method: "POST", path: `${sessionPath(this.sessionId)}/cancel`, idempotent: true, signal });
          return;
        } catch (err) {
          if (!unsupported(err)) throw err;
        }
      }
      this.statementId = await this.#recall(signal);
      if (this.statementId === undefined) return;
    }
    try {
      await http.void({ method: "POST", path: `${this.#statementPath()}/cancel`, idempotent: true, signal });
    } catch (err) {
      if (!WarpSqlError.is(err, ErrorCode.statementNotFound)) throw err;
    }
  }

  /**
   * Tells the server the client is done with the statement (§6.8), off the caller's path:
   * its result is freed, a query still running is cancelled, a write finishes with its
   * rows discarded.
   */
  free(): void {
    if (this.#freed || this.statementId === undefined || this.sessionId === undefined) return;
    this.#freed = true;
    const path = this.#statementPath();
    const http = this.core.http;
    this.core.background("statement delete", async () => {
      try {
        await http.void({ method: "DELETE", path, idempotent: true, signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        if (!WarpSqlError.is(err, ErrorCode.statementNotFound, ErrorCode.sessionNotFound)) throw err;
      }
    });
  }

  /** Ends the run: frees the statement and leaves the connection's running count. */
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.core.running--;
    if (this.#onAbort !== undefined) this.#userSignal?.removeEventListener("abort", this.#onAbort);
    this.free();
  }

  /** Ends a run that went wrong and returns the error to report. */
  fail(err: unknown): unknown {
    const reported = this.cancelled || this.signal.aborted ? this.cancelledError() : err;
    this.finish();
    return reported;
  }
}

/** Whether an error means the server does not have the endpoint called. */
export function unsupported(err: unknown): boolean {
  return WarpSqlError.is(err, ErrorCode.notFound, ErrorCode.methodNotAllowed, ErrorCode.notImplemented);
}

export async function decodeStatement(resp: Response): Promise<StatementDocument> {
  const doc = await decodeJSON<StatementDocument>(resp);
  if (typeof doc?.statement_id !== "string" || doc.statement_id === "") {
    throw protocolError(
      `the server answered ${resp.url ? new URL(resp.url).pathname : "a statement request"} without a statement id`,
    );
  }
  return doc;
}

/** A finished run's rows (or its update count), as a source of batches. */
export interface Rows {
  readonly source: BatchSource;
  readonly statementId: string | undefined;
  /** For a statement without rows: the rows it changed (null when the engine does not count). */
  readonly rowsAffected: number | null | undefined;
  /** The result's partition count. */
  readonly partitions: number;
}

/** Runs a statement for its rows. The caller reads `source` to its end or closes it. */
export async function runRows(exec: Execution): Promise<Rows> {
  try {
    if (exec.settings.async) {
      const resp = await exec.submit({ arrow: false, async: true });
      const doc = await decodeStatement(resp);
      exec.statementId = doc.statement_id;
      return await fromDocument(exec, await exec.waitDone(doc));
    }
    const resp = await exec.submit({ arrow: true, async: false });
    if (!isArrowResponse(resp)) {
      // A statement without rows answers with its document (§6.1).
      const doc = await decodeStatement(resp);
      exec.statementId = doc.statement_id;
      return await fromDocument(exec, await exec.waitDone(doc));
    }
    exec.statementId = resp.headers.get("warp-statement-id") ?? undefined;
    const split = splitHeaders(resp);
    if (split !== undefined) {
      // A split result (§6.10): this body is partition 0; the others are read at once.
      const stop = new AbortController();
      const signal = AbortSignal.any([exec.signal, stop.signal]);
      const parts = Array.from(
        { length: split.k },
        (_, i) => new PartReader(exec, i, undefined, signal, i === 0 ? resp : undefined),
      );
      const reader = new PartitionedReader(parts, split.order, stop);
      await reader.open();
      return {
        source: ending(exec, reader),
        statementId: exec.statementId,
        rowsAffected: undefined,
        partitions: split.k,
      };
    }
    const reader = new PartReader(exec, 0, undefined, exec.signal, resp);
    await reader.open();
    return { source: ending(exec, reader), statementId: exec.statementId, rowsAffected: undefined, partitions: 1 };
  } catch (err) {
    throw exec.fail(err);
  }
}

/** Reads how a streamed result was split (§6.10). */
function splitHeaders(resp: Response): { k: number; order: "interleaved" | "any" } | undefined {
  const k = Number(resp.headers.get("warp-result-partitions"));
  if (!Number.isInteger(k) || k < 2 || k > maxResultPartitions) return undefined;
  return { k, order: resp.headers.get("warp-result-order") === "interleaved" ? "interleaved" : "any" };
}

/** Turns a finished statement into its rows or its count. */
async function fromDocument(exec: Execution, doc: StatementDocument): Promise<Rows> {
  if (doc.state !== "succeeded") throw statementError(doc);
  const result = doc.result;
  if (result === undefined || result === null)
    throw protocolError(`statement ${doc.statement_id} succeeded without a result`);
  if (result.kind !== "rows") {
    exec.finish();
    const affected = typeof result.rows_affected === "number" ? result.rows_affected : null;
    return { source: emptySource(), statementId: doc.statement_id, rowsAffected: affected, partitions: 0 };
  }
  const partitions = result.partitions ?? [{ index: 0 }];
  if (partitions.length === 0) throw protocolError(`statement ${doc.statement_id} has a row result without partitions`);
  const order = result.partition_order;
  const local = partitions.length > 1 && (order === "interleaved" || order === "any");
  const stop = new AbortController();
  const signal = local ? AbortSignal.any([exec.signal, stop.signal]) : exec.signal;
  const parts = partitions.map((p) => new PartReader(exec, p.index, partitionLocation(p.index, p.location), signal));
  const reader = local ? new PartitionedReader(parts, order, stop) : new SequentialReader(parts);
  await reader.open();
  return {
    source: ending(exec, reader),
    statementId: doc.statement_id,
    rowsAffected: undefined,
    partitions: parts.length,
  };
}

function partitionLocation(index: number, location: string | null | undefined): URL | undefined {
  if (location === null || location === undefined || location === "") return undefined;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw protocolError(`partition ${index} has an invalid location ${JSON.stringify(location)}`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") {
    throw protocolError(`partition ${index} has an invalid location ${JSON.stringify(location)}`);
  }
  return url;
}

function emptySource(): BatchSource {
  return {
    schema: new Schema([]),
    next: () => Promise.resolve({ value: undefined, done: true }),
    close: () => Promise.resolve(),
  };
}

/** A source that ends its run when it is read to the end, fails, or is closed. */
function ending(exec: Execution, source: BatchSource): BatchSource {
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    exec.finish();
  };
  return {
    get schema() {
      return source.schema;
    },
    async next() {
      try {
        const result = await source.next();
        if (result.done) end();
        return result;
      } catch (err) {
        const reported = exec.cancelled ? exec.cancelledError() : err;
        await source.close().catch(() => {});
        end();
        throw reported;
      }
    },
    async close() {
      await source.close();
      end();
    },
  };
}

/** Runs a statement for its update count (§6.1, status-document path). */
export async function runUpdate(exec: Execution): Promise<number | null> {
  try {
    const resp = await exec.submit({ arrow: false, async: exec.settings.async });
    if (isArrowResponse(resp)) {
      await discard(resp);
      throw protocolError("the server answered a statement-document request with an Arrow stream");
    }
    const first = await decodeStatement(resp);
    exec.statementId = first.statement_id;
    const doc = await exec.waitDone(first);
    if (doc.state !== "succeeded") throw statementError(doc);
    exec.finish();
    const result = doc.result;
    if (result?.kind !== "update") return null;
    return typeof result.rows_affected === "number" ? result.rows_affected : null;
  } catch (err) {
    throw exec.fail(err);
  }
}

// Licensed under the Apache License, Version 2.0.

import {
  type AsyncRecordBatchStreamReader,
  type RecordBatch,
  RecordBatchReader,
  type Schema,
  util,
} from "apache-arrow";

import { ErrorCode, WarpSqlError, protocolError } from "./errors.js";
import { abortError, mediaTypeArrow, sleep } from "./http.js";
import { ScannedBody, incompleteStream } from "./ipc.js";
import { isTerminal } from "./protocol.js";
import { AsyncQueue } from "./queue.js";
import type { Execution } from "./statement.js";
import { statementError } from "./statement.js";

/** How often one partition's download is resumed, at most. */
const maxResumes = 5;
/** How long a broken unretained download waits for its statement to settle, to report the statement's own error. */
const settleWaitS = 2;
/** How many batches each partition's download may hold ahead of the reader. */
const partitionBuffer = 2;

/** A source of record batches with a known schema. */
export interface BatchSource {
  readonly schema: Schema;
  next(): Promise<IteratorResult<RecordBatch, undefined>>;
  /** Stops reading and releases every download. */
  close(): Promise<void>;
}

export function isArrowResponse(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().startsWith(mediaTypeArrow);
}

/**
 * One partition of a result (§6.2), read as an Arrow stream. When the stream breaks off,
 * it asks the server why: a retained result resumes from the next batch (§6.5), a failed
 * statement reports the statement's error (§6.6), and anything else is an error. A stream
 * without its end-of-stream marker is never taken for a complete result.
 */
export class PartReader implements BatchSource {
  readonly #exec: Execution;
  readonly #index: number;
  readonly #location: URL | undefined;
  readonly #signal: AbortSignal;
  #first: Response | undefined;
  #schema: Schema | undefined;
  #reader: AsyncRecordBatchStreamReader | undefined;
  #body: ScannedBody | undefined;
  #batches = 0;
  #resumes = 0;
  #done = false;

  constructor(exec: Execution, index: number, location: URL | undefined, signal: AbortSignal, first?: Response) {
    this.#exec = exec;
    this.#index = index;
    this.#location = location;
    this.#signal = signal;
    this.#first = first;
  }

  get index(): number {
    return this.#index;
  }

  get schema(): Schema {
    if (this.#schema === undefined) throw new Error("the partition is not open");
    return this.#schema;
  }

  /** Opens the download, so the schema is known. */
  async open(): Promise<void> {
    if (this.#reader !== undefined || this.#done) return;
    const first = this.#first;
    this.#first = undefined;
    try {
      if (first !== undefined) await this.#attach(first);
      else await this.#request();
    } catch (err) {
      if (!this.#breakage(err)) throw err;
      await this.#recover(err);
      await this.open();
    }
  }

  async next(): Promise<IteratorResult<RecordBatch, undefined>> {
    for (;;) {
      if (this.#done) return { value: undefined, done: true };
      try {
        if (this.#reader === undefined) await this.#request();
        const result = await this.#reader!.next();
        if (!result.done) {
          this.#batches++;
          return { value: result.value, done: false };
        }
        if (!this.#body!.scanner.sawEos) throw incompleteStream();
        this.#done = true;
        await this.#release();
        return { value: undefined, done: true };
      } catch (err) {
        await this.#release();
        if (!this.#breakage(err)) throw this.#explain(err);
        await this.#recover(err);
      }
    }
  }

  async close(): Promise<void> {
    this.#done = true;
    const first = this.#first;
    this.#first = undefined;
    if (first?.body) await first.body.cancel().catch(() => {});
    await this.#release();
  }

  /** Requests the partition from the batch after the last one read (§6.4). */
  async #request(): Promise<void> {
    const exec = this.#exec;
    for (let attempt = 0; ; attempt++) {
      try {
        const resp = await exec.result({
          partition: this.#index,
          fromBatch: this.#batches,
          location: this.#location,
          signal: this.#signal,
        });
        await this.#attach(resp);
        return;
      } catch (err) {
        if (WarpSqlError.is(err, ErrorCode.resultNotReady) && attempt < maxResumes) {
          // No schema yet: wait for the statement to make progress (§6.4).
          await exec.status(settleWaitS, this.#signal);
          continue;
        }
        throw this.#explain(err);
      }
    }
  }

  async #attach(resp: Response): Promise<void> {
    if (!isArrowResponse(resp) || resp.body === null) {
      await resp.body?.cancel().catch(() => {});
      throw protocolError(
        `partition ${this.#index} was answered with ${resp.headers.get("content-type") ?? "no content type"}, not an Arrow stream`,
      );
    }
    const body = new ScannedBody(resp.body);
    this.#body = body;
    const reader = (await RecordBatchReader.from(body)) as AsyncRecordBatchStreamReader;
    this.#reader = reader;
    await reader.open();
    const schema = reader.schema;
    if (this.#schema === undefined) {
      this.#schema = schema;
    } else if (!util.compareSchemas(this.#schema, schema)) {
      throw protocolError(`partition ${this.#index} came back with a different schema after resuming`);
    }
  }

  async #release(): Promise<void> {
    this.#body?.finish();
    this.#body = undefined;
    const reader = this.#reader;
    this.#reader = undefined;
    if (reader !== undefined) await reader.cancel().catch(() => {});
  }

  /** Whether an error is the stream breaking off (a cut connection, a missing marker), which a resume may cure. */
  #breakage(err: unknown): boolean {
    if (this.#signal.aborted || this.#exec.cancelled) return true; // reported as the cancellation by #recover
    if (err instanceof WarpSqlError) return err.code === ErrorCode.incompleteStream;
    return (
      err instanceof TypeError || (err instanceof Error && /terminated|network|socket|reset|aborted/i.test(err.message))
    );
  }

  /** The error to report for a failure that is not a breakage. */
  #explain(err: unknown): unknown {
    if (this.#exec.cancelled || this.#signal.aborted) return this.#exec.cancelledError(this.#signal);
    return err;
  }

  /** Handles a stream that broke off: reports the statement's error, or resumes a retained result. */
  async #recover(streamErr: unknown): Promise<void> {
    const exec = this.#exec;
    if (exec.cancelled || this.#signal.aborted) throw exec.cancelledError(this.#signal);
    let doc;
    try {
      doc = await exec.status(0, this.#signal);
    } catch (err) {
      if (exec.cancelled || this.#signal.aborted) throw exec.cancelledError(this.#signal);
      throw incompleteStream(
        `the result stream broke off (${describe(streamErr)}), and the statement's status could not be read: ${describe(err)}`,
      ).with({
        statementId: exec.statementId,
        cause: err,
      });
    }
    const retained = doc.result?.retained === true;
    if (!retained && !isTerminal(doc.state)) {
      // An unretained result can't be resumed; let the statement settle so its own error can be reported.
      try {
        doc = await exec.status(settleWaitS, this.#signal);
      } catch {
        // Keep the first answer.
      }
    }
    if (doc.state === "failed" || (doc.state === "cancelled" && doc.cancel_reason !== "client")) {
      throw statementError(doc);
    }
    if (!retained) {
      throw incompleteStream(
        `the result stream broke off (${describe(streamErr)}); the server did not retain the result, so it cannot be ` +
          "resumed (pass retainResult: true or async: true to make downloads resumable)",
      ).with({ statementId: exec.statementId, cause: streamErr });
    }
    if (this.#resumes >= maxResumes) {
      throw incompleteStream(`the result stream broke off ${this.#resumes} times; last: ${describe(streamErr)}`).with({
        statementId: exec.statementId,
        cause: streamErr,
      });
    }
    this.#resumes++;
    exec.core.logger.debug?.("resuming a result download", {
      partition: this.#index,
      fromBatch: this.#batches,
      resume: this.#resumes,
    });
    await sleep(Math.min(this.#resumes * 250, 2000), this.#signal);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A result split into partitions on this server (§6.10): every partition read at once,
 * each over its own connection with its own PartReader, merged into one stream.
 * `interleaved` partitions are merged round robin, which is the result's order; `any`
 * partitions as their batches arrive. The result is complete only when every partition
 * ended with its end-of-stream marker; the first partition that fails fails the whole
 * result and stops the others.
 */
export class PartitionedReader implements BatchSource {
  readonly #parts: PartReader[];
  readonly #order: "interleaved" | "any";
  readonly #stop: AbortController;
  #queues: AsyncQueue<RecordBatch>[] = [];
  #merged: AsyncQueue<RecordBatch> | undefined;
  #pumps: Promise<void>[] = [];
  #failure: unknown;
  #failed = false;
  #next = 0;
  #done = false;

  /** `stop` aborts every partition's download; the parts were created with its signal. */
  constructor(parts: PartReader[], order: "interleaved" | "any", stop: AbortController) {
    this.#parts = parts;
    this.#order = order;
    this.#stop = stop;
  }

  get schema(): Schema {
    return this.#parts[0]!.schema;
  }

  /** Opens partition 0 (its schema is the result's) and starts every download. */
  async open(): Promise<void> {
    try {
      await this.#parts[0]!.open();
    } catch (err) {
      await this.#shutdown();
      throw err;
    }
    const k = this.#parts.length;
    if (this.#order === "interleaved") {
      this.#queues = this.#parts.map(() => new AsyncQueue<RecordBatch>(partitionBuffer));
    } else {
      this.#merged = new AsyncQueue<RecordBatch>(partitionBuffer * k, k);
    }
    this.#pumps = this.#parts.map((part, i) => this.#pump(part, i));
  }

  async #pump(part: PartReader, i: number): Promise<void> {
    const queue = this.#merged ?? this.#queues[i]!;
    try {
      if (i > 0) {
        await part.open();
        if (!util.compareSchemas(part.schema, this.schema)) {
          throw protocolError(`partition ${part.index} has another schema than partition 0`);
        }
      }
      for (;;) {
        const result = await part.next();
        if (result.done) break;
        if (!(await queue.push(result.value))) return;
      }
      queue.close();
    } catch (err) {
      this.#fail(err);
    } finally {
      await part.close();
    }
  }

  #fail(err: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#failure = err;
    this.#stop.abort(
      new WarpSqlError({ code: ErrorCode.executionError, message: "another partition failed", cause: err }),
    );
    for (const queue of this.#queues) queue.fail(err);
    this.#merged?.fail(err);
  }

  async next(): Promise<IteratorResult<RecordBatch, undefined>> {
    if (this.#done) return { value: undefined, done: true };
    try {
      if (this.#merged !== undefined) {
        const result = await this.#merged.next();
        if (result.done) return await this.#finish();
        return result;
      }
      const result = await this.#queues[this.#next]!.next();
      if (!result.done) {
        this.#next = (this.#next + 1) % this.#queues.length;
        return result;
      }
      // Round robin: once a partition has no next batch, none has (§6.10).
      for (const queue of this.#queues) {
        const extra = await queue.next();
        if (!extra.done) {
          this.#fail(protocolError("a partition has more batches than an interleaved result allows"));
          throw this.#failure;
        }
      }
      return await this.#finish();
    } catch (err) {
      await this.#shutdown();
      throw this.#failure ?? err;
    }
  }

  async #finish(): Promise<IteratorResult<RecordBatch, undefined>> {
    await Promise.all(this.#pumps);
    if (this.#failed) throw this.#failure;
    this.#done = true;
    return { value: undefined, done: true };
  }

  async #shutdown(): Promise<void> {
    this.#done = true;
    if (!this.#stop.signal.aborted)
      this.#stop.abort(new WarpSqlError({ code: ErrorCode.statementCancelled, message: "the result was closed" }));
    const closed =
      this.#failure ?? new WarpSqlError({ code: ErrorCode.statementCancelled, message: "the result was closed" });
    for (const queue of this.#queues) queue.fail(closed);
    this.#merged?.fail(closed);
    // Cancel the downloads first: a pump may be waiting on a body that will not move.
    await Promise.all(this.#parts.map((part) => part.close()));
    await Promise.all(this.#pumps);
  }

  async close(): Promise<void> {
    if (this.#done && this.#pumps.length === 0) return;
    await this.#shutdown();
  }
}

/** Partitions read one after another: those on other servers (§6.2), whose order the result does not fix. */
export class SequentialReader implements BatchSource {
  readonly #parts: PartReader[];
  #current = 0;

  constructor(parts: PartReader[]) {
    this.#parts = parts;
  }

  get schema(): Schema {
    return this.#parts[0]!.schema;
  }

  async open(): Promise<void> {
    await this.#parts[0]!.open();
  }

  async next(): Promise<IteratorResult<RecordBatch, undefined>> {
    while (this.#current < this.#parts.length) {
      const part = this.#parts[this.#current]!;
      await part.open();
      if (this.#current > 0 && !util.compareSchemas(part.schema, this.schema)) {
        throw protocolError(`partition ${part.index} has another schema than partition 0`);
      }
      const result = await part.next();
      if (!result.done) return result;
      this.#current++;
    }
    return { value: undefined, done: true };
  }

  async close(): Promise<void> {
    await Promise.all(this.#parts.map((part) => part.close()));
  }
}

/** Reports a signal's abort as the statement's cancellation. */
export function cancelled(signal: AbortSignal, statementId: string | undefined): WarpSqlError {
  return abortError(signal, statementId);
}

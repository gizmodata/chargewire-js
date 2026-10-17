// Licensed under the Apache License, Version 2.0.

import { type RecordBatch, type Schema, Table } from "apache-arrow";

import type { Core, OpenStream } from "./core.js";
import { ErrorCode, WarpSqlError } from "./errors.js";
import { batchBytes } from "./ipc.js";
import type { Rows } from "./statement.js";

/**
 * A query's result as it streams: an async iterable of Arrow record batches. Batches are
 * read from the network as they are asked for, so a slow consumer holds the download
 * back. Break out of the loop (or call `close`) to stop early: the statement is then
 * released on the server, which stops a query still running.
 *
 * The stream ends only when the server's end-of-stream marker arrived; a stream cut
 * short never ends quietly, it throws.
 */
export class ResultStream implements AsyncIterableIterator<RecordBatch, undefined, undefined>, OpenStream {
  readonly #core: Core;
  readonly #opening: Promise<Rows>;
  readonly #onEnd: (() => void) | undefined;
  #rows: Rows | undefined;
  #lock: Promise<unknown> = Promise.resolve();
  readonly #buffer: RecordBatch[] = [];
  #done = false;
  #error: unknown;
  #dropped: WarpSqlError | undefined;
  #registered = false;
  #ended = false;

  /** @internal Created by `Connection.stream` and `PreparedStatement.stream`. */
  constructor(core: Core, opening: Promise<Rows>, options: { register: boolean; onEnd?: () => void }) {
    this.#core = core;
    this.#onEnd = options.onEnd;
    this.#opening = opening.then(
      (rows) => {
        this.#rows = rows;
        return rows;
      },
      (err: unknown) => {
        this.#error = err;
        this.#end();
        throw err;
      },
    );
    this.#opening.catch(() => {}); // reported by the first read, not as an unhandled rejection
    if (options.register) {
      this.#registered = true;
      core.openStreams.add(this);
    }
  }

  /** The result's schema, once the server has sent it. */
  async schema(): Promise<Schema> {
    return (await this.#opening).source.schema;
  }

  /** The statement's id on the server, once known. */
  get statementId(): string | undefined {
    return this.#rows?.statementId;
  }

  /** For a statement without rows (DDL, DML): the rows it changed, or null when the engine does not count. */
  async rowsAffected(): Promise<number | null | undefined> {
    return (await this.#opening).rowsAffected;
  }

  /** How many partitions the result was read in (§6.10). */
  async partitions(): Promise<number> {
    return (await this.#opening).partitions;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<RecordBatch, undefined>> {
    return this.#locked(() => this.#next());
  }

  async #next(): Promise<IteratorResult<RecordBatch, undefined>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return { value: buffered, done: false };
    if (this.#dropped !== undefined) throw this.#dropped;
    if (this.#error !== undefined) throw this.#error as Error;
    if (this.#done) return { value: undefined, done: true };
    const rows = await this.#opening;
    try {
      const result = await rows.source.next();
      if (result.done) {
        this.#done = true;
        this.#end();
      }
      return result;
    } catch (err) {
      this.#error = err;
      this.#end();
      throw err;
    }
  }

  /** Stops reading (for `for await … break`). */
  async return(): Promise<IteratorResult<RecordBatch, undefined>> {
    await this.close();
    return { value: undefined, done: true };
  }

  /**
   * Stops the stream and releases the statement on the server: a query still running is
   * cancelled, a write (`INSERT … RETURNING`) finishes with its rows discarded (§6.8).
   */
  close(): Promise<void> {
    return this.#locked(async () => {
      if (this.#done && this.#buffer.length === 0) return;
      this.#done = true;
      this.#buffer.length = 0;
      try {
        const rows = await this.#opening;
        await rows.source.close();
      } catch {
        // Failed to open: nothing to release.
      } finally {
        this.#end();
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Reads the rest of the stream into a Table. */
  async toTable(): Promise<Table> {
    const schema = await this.schema();
    const batches: RecordBatch[] = [];
    for await (const batch of this) batches.push(batch);
    return new Table(schema, batches);
  }

  /** @internal Reads ahead into memory, up to `limit` bytes, so the session can serve another request. */
  bufferRest(limit: number): Promise<void> {
    return this.#locked(async () => {
      if (this.#done || this.#error !== undefined) return;
      let rows: Rows;
      try {
        rows = await this.#opening;
      } catch {
        return;
      }
      let size = this.#buffer.reduce((n, b) => n + batchBytes(b), 0);
      try {
        for (;;) {
          const result = await rows.source.next();
          if (result.done) {
            this.#done = true;
            this.#end();
            return;
          }
          this.#buffer.push(result.value);
          size += batchBytes(result.value);
          if (size > limit) break;
        }
      } catch (err) {
        this.#error = err;
        this.#end();
        return;
      }
      // Too big to hold: drop the rest, and say so when the reader gets there.
      this.#dropped = new WarpSqlError({
        code: ErrorCode.resultBufferExceeded,
        statementId: rows.statementId,
        message:
          `the rest of this result was dropped: another request needed the connection's session while the result ` +
          `was unread, and more than resultBufferBytes (${limit}) of it was left. Read results before running the ` +
          `next statement on the connection, or open another connection for it`,
      });
      this.#done = true;
      await rows.source.close().catch(() => {});
      this.#end();
    });
  }

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => {});
    return run;
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#registered) {
      this.#registered = false;
      this.#core.openStreams.delete(this);
    }
    if (this.#onEnd !== undefined) queueMicrotask(this.#onEnd);
  }
}

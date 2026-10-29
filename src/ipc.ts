// Licensed under the Apache License, Version 2.0.

import {
  RecordBatch,
  RecordBatchReader,
  RecordBatchStreamWriter,
  type Schema,
  Table,
  isArrowRecordBatch,
  isArrowTable,
  tableToIPC,
  util,
} from "apache-arrow";

import { ErrorCode, ChargewireError, invalidArgument, protocolError } from "./errors.js";
import type { RequestBody } from "./http.js";
import { mediaTypeArrow } from "./http.js";

/** Arrow's message header types (Message.fbs). */
const headerRecordBatch = 3;

/**
 * Watches an Arrow IPC stream go by and tells a complete stream from a cut one (§6.6).
 * Chunks pass through unchanged; only each message's small metadata is copied, to read
 * its body length. A stream is complete only when its end-of-stream marker arrived.
 */
export class IpcScanner {
  /** Record-batch messages fully received. */
  recordBatches = 0;
  /** Whether the end-of-stream marker was seen. */
  sawEos = false;
  /** Bytes seen. */
  bytes = 0;

  #state: "prefix" | "length" | "metadata" | "body" | "done" = "prefix";
  #need = 4; // bytes still needed for the current state
  #scratch = new Uint8Array(8);
  #scratchLength = 0;
  #metadata: Uint8Array | undefined;
  #bodyLeft = 0;
  #bodyIsBatch = false;

  /** Feeds a chunk; throws on bytes that cannot be an Arrow stream. */
  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    let i = 0;
    while (i < chunk.byteLength) {
      switch (this.#state) {
        case "done":
          return; // bytes after the marker are not part of the stream
        case "prefix":
        case "length": {
          const take = Math.min(this.#need, chunk.byteLength - i);
          this.#scratch.set(chunk.subarray(i, i + take), this.#scratchLength);
          this.#scratchLength += take;
          this.#need -= take;
          i += take;
          if (this.#need === 0) this.#onWord();
          break;
        }
        case "metadata": {
          const metadata = this.#metadata!;
          const take = Math.min(this.#need, chunk.byteLength - i);
          metadata.set(chunk.subarray(i, i + take), metadata.byteLength - this.#need);
          this.#need -= take;
          i += take;
          if (this.#need === 0) this.#onMetadata(metadata);
          break;
        }
        case "body": {
          const take = Math.min(this.#bodyLeft, chunk.byteLength - i);
          this.#bodyLeft -= take;
          i += take;
          if (this.#bodyLeft === 0) this.#endMessage();
          break;
        }
      }
    }
  }

  #onWord(): void {
    const word = new DataView(this.#scratch.buffer, 0, 4).getUint32(0, true);
    this.#scratchLength = 0;
    if (this.#state === "prefix" && word === 0xffffffff) {
      this.#state = "length"; // continuation marker: the metadata length follows
      this.#need = 4;
      return;
    }
    // The metadata length (after a continuation marker, or alone in the legacy format).
    if (word === 0) {
      this.sawEos = true;
      this.#state = "done";
      return;
    }
    if (word > 0x7fffffff) throw protocolError("the Arrow stream has an invalid message length");
    this.#metadata = new Uint8Array(word);
    this.#state = "metadata";
    this.#need = word;
  }

  #onMetadata(metadata: Uint8Array): void {
    const { headerType, bodyLength } = readMessageHeader(metadata);
    this.#metadata = undefined;
    this.#bodyIsBatch = headerType === headerRecordBatch;
    if (bodyLength === 0) {
      this.#endMessage();
      return;
    }
    this.#state = "body";
    this.#bodyLeft = bodyLength;
  }

  #endMessage(): void {
    if (this.#bodyIsBatch) this.recordBatches++;
    this.#bodyIsBatch = false;
    this.#state = "prefix";
    this.#need = 4;
  }
}

/** Reads a Message flatbuffer's header type and body length. */
export function readMessageHeader(metadata: Uint8Array): { headerType: number; bodyLength: number } {
  const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength);
  try {
    const table = view.getUint32(0, true);
    const vtable = table - view.getInt32(table, true);
    const vtableLength = view.getUint16(vtable, true);
    const field = (slot: number): number => {
      const at = 4 + 2 * slot;
      return at < vtableLength ? view.getUint16(vtable + at, true) : 0;
    };
    // Message: version (0), header_type (1), header (2), bodyLength (3), custom_metadata (4).
    const headerTypeAt = field(1);
    const bodyLengthAt = field(3);
    const headerType = headerTypeAt === 0 ? 0 : view.getUint8(table + headerTypeAt);
    const bodyLength = bodyLengthAt === 0 ? 0 : Number(view.getBigInt64(table + bodyLengthAt, true));
    if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) throw new RangeError("body length");
    return { headerType, bodyLength };
  } catch (err) {
    throw protocolError("the Arrow stream has an unreadable message header", err);
  }
}

/** The error for a stream that ended without its end-of-stream marker. */
export function incompleteStream(detail?: string): ChargewireError {
  return new ChargewireError({
    code: ErrorCode.clientIncompleteStream,
    message: "the Arrow stream ended without its end-of-stream marker" + (detail ? `: ${detail}` : ""),
  });
}

/**
 * A fetch body read chunk by chunk through a scanner; iterating it ends with an error
 * when the stream is cut. `cancel` stops the download at once, even while a read waits.
 */
export class ScannedBody implements AsyncIterable<Uint8Array> {
  readonly scanner = new IpcScanner();
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #cancelled = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#reader.cancel().catch(() => {});
  }

  /**
   * Ends reading. After the end-of-stream marker the rest of the body (normally nothing) is
   * read out, so the HTTP connection goes back to the pool; before it, the download stops.
   */
  finish(): void {
    if (this.#cancelled) return;
    if (!this.scanner.sawEos) {
      this.cancel();
      return;
    }
    this.#cancelled = true;
    const drain = async (): Promise<void> => {
      for (let n = 0; n < 1024; n++) if ((await this.#reader.read()).done) return;
      await this.#reader.cancel();
    };
    drain().catch(() => {});
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done || this.#cancelled) break;
        this.scanner.push(value);
        yield value;
        if (this.scanner.sawEos) break;
      }
    } finally {
      this.finish(); // whenever reading stops
    }
    if (!this.scanner.sawEos) throw incompleteStream();
  }
}

/** Decodes a schema embedded in JSON: base64 of an IPC stream with only the schema (§2.2). */
export function decodeSchema(base64: string | null | undefined): Schema | undefined {
  if (base64 === null || base64 === undefined || base64 === "") return undefined;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch (err) {
    throw protocolError("the server sent a schema that is not base64", err);
  }
  return schemaFromIpc(bytes);
}

/** Reads the schema of an IPC stream (or of a lone schema message without the marker). */
export function schemaFromIpc(bytes: Uint8Array): Schema {
  try {
    const reader = RecordBatchReader.from(bytes);
    reader.open();
    return reader.schema;
  } catch (err) {
    throw protocolError("the server sent an Arrow schema that cannot be read", err);
  }
}

/** Rows to upload: a table, one batch, or batches from any (async) iterable. */
export type ArrowInput = Table | RecordBatch | Iterable<RecordBatch> | AsyncIterable<RecordBatch>;

/** The schema and batches of an upload. Reads ahead one batch when the input is an iterable. */
export async function openInput(input: ArrowInput): Promise<{ schema: Schema; batches: AsyncIterable<RecordBatch> }> {
  if (isArrowTable(input)) {
    const table = input as Table;
    return { schema: table.schema, batches: toAsync(table.batches) };
  }
  if (isArrowRecordBatch(input)) {
    const batch = input as RecordBatch;
    return { schema: batch.schema, batches: toAsync([batch]) };
  }
  const iterable = input as Partial<Iterable<RecordBatch> & AsyncIterable<RecordBatch>>;
  let iterator: AsyncIterator<RecordBatch> | Iterator<RecordBatch>;
  const asyncIterate = iterable[Symbol.asyncIterator];
  const syncIterate = iterable[Symbol.iterator];
  if (typeof asyncIterate === "function") iterator = asyncIterate.call(iterable);
  else if (typeof syncIterate === "function") iterator = syncIterate.call(iterable);
  else throw invalidArgument("Arrow data must be a Table, a RecordBatch, or an (async) iterable of RecordBatches");
  const first = await iterator.next();
  if (first.done) {
    throw invalidArgument("the Arrow data has no batches, so no schema; pass a Table (which has one even when empty)");
  }
  if (!isArrowRecordBatch(first.value))
    throw invalidArgument("the iterable yielded something that is not a RecordBatch");
  const schema = first.value.schema;
  async function* rest(): AsyncGenerator<RecordBatch> {
    yield first.value as RecordBatch;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      if (!isArrowRecordBatch(next.value))
        throw invalidArgument("the iterable yielded something that is not a RecordBatch");
      yield next.value;
    }
  }
  return { schema, batches: rest() };
}

async function* toAsync<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}

/** Bytes of encoded batches held ahead of the reader while encoding an upload. */
const encodeAheadBytes = 8 << 20;

/**
 * Encodes batches as one Arrow IPC stream, chunk by chunk, holding at most about
 * `encodeAheadBytes` of encoded batches ahead of the reader.
 *
 * The writer is read as an async iterable, not through `RecordBatchStreamWriter.throughDOM()`:
 * that is installed only as a side effect of Arrow's DOM entry point, which bundlers drop
 * (apache-arrow declares `"sideEffects": false`), so a bundled browser app had no
 * `throughDOM` and every upload failed with '"throughDOM" not available in this environment'.
 */
export async function* encodeStream(schema: Schema, batches: AsyncIterable<RecordBatch>): AsyncGenerator<Uint8Array> {
  const iterator = batches[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    yield tableToIPC(new Table(schema), "stream"); // the schema and the end-of-stream marker
    return;
  }
  const writer = new RecordBatchStreamWriter();
  let ahead = 0;
  let wake: (() => void) | undefined;
  let stopped = false;
  let feedError: unknown;
  const feed = (async () => {
    try {
      let next: IteratorResult<RecordBatch> = first;
      while (!next.done && !stopped) {
        if (!util.compareSchemas(next.value.schema, schema)) {
          throw invalidArgument("every batch of an upload must have the same schema");
        }
        while (ahead > encodeAheadBytes && !stopped) await new Promise<void>((resolve) => (wake = resolve));
        if (stopped) break;
        ahead += batchBytes(next.value);
        writer.write(next.value);
        next = await iterator.next();
      }
    } catch (err) {
      feedError = err;
    } finally {
      // Ends the stream (with the end-of-stream marker); after an error the reader stops
      // first, so a cut stream is never mistaken for a whole one.
      writer.close();
    }
  })();
  try {
    for await (const chunk of writer as AsyncIterable<Uint8Array>) {
      if (feedError !== undefined) break;
      ahead -= chunk.byteLength;
      const w = wake;
      wake = undefined;
      w?.();
      yield chunk;
    }
    await feed;
    if (feedError !== undefined) throw feedError as Error;
  } finally {
    stopped = true;
    wake?.();
    await feed;
    await iterator.return?.();
  }
}

/** The largest upload kept in memory, so its request can be sent again (§6.7). */
export const uploadReplayLimit = 16 << 20;

/**
 * Encodes rows as a request body. A body up to `limit` bytes is held in memory and can be
 * sent again; a larger one streams as it is encoded (when the platform can stream request
 * bodies) and is sent once.
 */
export async function arrowBody(
  input: ArrowInput,
  options: { streaming: boolean; limit?: number },
): Promise<RequestBody> {
  const { schema, batches } = await openInput(input);
  const limit = options.limit ?? uploadReplayLimit;
  const chunks = encodeStream(schema, batches);
  const held: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await chunks.next();
    if (next.done) return { contentType: mediaTypeArrow, bytes: concat(held, size) };
    held.push(next.value);
    size += next.value.byteLength;
    if (options.streaming && size > limit) break;
  }
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < held.length) {
        controller.enqueue(held[index]!);
        held[index++] = new Uint8Array(0);
        return;
      }
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return { contentType: mediaTypeArrow, stream };
}

export function concat(chunks: readonly Uint8Array[], size?: number): Uint8Array {
  const total = size ?? chunks.reduce((n, c) => n + c.byteLength, 0);
  if (chunks.length === 1 && chunks[0]!.byteLength === total) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** About how many bytes a batch holds, for buffering limits. */
export function batchBytes(batch: RecordBatch): number {
  return batch.data.byteLength;
}

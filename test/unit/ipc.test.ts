import { Table, tableFromArrays, tableToIPC } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ErrorCode, WarpSqlError } from "../../src/index.js";
import {
  IpcScanner,
  ScannedBody,
  arrowBody,
  concat,
  decodeSchema,
  encodeStream,
  openInput,
  readMessageHeader,
} from "../../src/ipc.js";

const table = tableFromArrays({
  a: Int32Array.from({ length: 5000 }, (_, i) => i),
  s: Array.from({ length: 5000 }, (_, i) => `v${i}`),
});
const threeBatches = new Table([...table.batches, ...table.slice(0, 10).batches, ...table.slice(10, 20).batches]);
const stream = tableToIPC(threeBatches, "stream");

function bodyOf(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

describe("IpcScanner (§6.6)", () => {
  test("a complete stream ends with its end-of-stream marker; its batches are counted", () => {
    for (const chunk of [1, 7, 64, 4096, stream.length]) {
      const scanner = new IpcScanner();
      for (let i = 0; i < stream.length; i += chunk) scanner.push(stream.subarray(i, i + chunk));
      expect(scanner.sawEos).toBe(true);
      expect(scanner.recordBatches).toBe(threeBatches.batches.length);
    }
  });

  test("a stream cut anywhere before the marker is incomplete", () => {
    for (let cut = 0; cut < stream.length; cut += Math.max(1, Math.floor(stream.length / 300))) {
      const scanner = new IpcScanner();
      scanner.push(stream.subarray(0, cut));
      expect(scanner.sawEos, `cut at ${cut}`).toBe(false);
    }
    const scanner = new IpcScanner();
    scanner.push(stream.subarray(0, stream.length - 1));
    expect(scanner.sawEos).toBe(false);
  });

  test("the legacy end-of-stream marker (four zero bytes) counts", () => {
    const legacy = concat([stream.subarray(0, stream.length - 8), new Uint8Array(4)]);
    const scanner = new IpcScanner();
    scanner.push(legacy);
    expect(scanner.sawEos).toBe(true);
  });

  test("garbage is a protocol error, not an incomplete stream", () => {
    const scanner = new IpcScanner();
    expect(() => scanner.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 8, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      expect.objectContaining({ code: ErrorCode.protocolError }),
    );
  });

  test("readMessageHeader reads the schema message's body length (0)", () => {
    const metadataLength = new DataView(stream.buffer, stream.byteOffset + 4, 4).getInt32(0, true);
    const header = readMessageHeader(stream.subarray(8, 8 + metadataLength));
    expect(header).toEqual({ headerType: 1, bodyLength: 0 });
  });

  test("ScannedBody passes a complete body through and throws on a cut one", async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of new ScannedBody(bodyOf(stream, 333))) chunks.push(chunk);
    expect(concat(chunks)).toEqual(stream);
    const cut = new ScannedBody(bodyOf(stream.subarray(0, stream.length - 8), 333));
    await expect(async () => {
      for await (const _ of cut) {
        // drain
      }
    }).rejects.toMatchObject({ code: ErrorCode.incompleteStream });
  });
});

describe("encoding uploads", () => {
  test("a small upload is held in memory; a big one streams", async () => {
    const small = await arrowBody(table, { streaming: true });
    expect(small.bytes).toBeDefined();
    const big = await arrowBody(threeBatches, { streaming: true, limit: 1000 });
    expect(big.stream).toBeDefined();
    const reader = big.stream!.getReader();
    const parts: Uint8Array[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
    expect(concat(parts).length).toBeGreaterThan(1000);
    // A platform that cannot stream uploads holds even a big one.
    expect((await arrowBody(threeBatches, { streaming: false, limit: 1000 })).bytes).toBeDefined();
  });

  test("an empty table still sends its schema", async () => {
    const empty = new Table(table.schema);
    const chunks: Uint8Array[] = [];
    const { schema, batches } = await openInput(empty);
    for await (const c of encodeStream(schema, batches)) chunks.push(c);
    const scanner = new IpcScanner();
    scanner.push(concat(chunks));
    expect(scanner.sawEos).toBe(true);
    expect(scanner.recordBatches).toBe(0);
  });

  test("batches of different schemas are refused", async () => {
    const other = tableFromArrays({ b: Float64Array.from([1]) });
    await expect(arrowBody([table.batches[0]!, other.batches[0]!], { streaming: false })).rejects.toMatchObject({
      code: ErrorCode.invalidArgument,
    });
    await expect(arrowBody([table.batches[0]!, table.batches[0]!], { streaming: false })).resolves.toHaveProperty(
      "bytes",
    );
  });

  test("inputs that are not Arrow are refused", async () => {
    await expect(openInput({} as never)).rejects.toBeInstanceOf(WarpSqlError);
    await expect(openInput([] as never)).rejects.toMatchObject({ code: ErrorCode.invalidArgument });
    await expect(openInput([1] as never)).rejects.toMatchObject({ code: ErrorCode.invalidArgument });
  });
});

describe("schemas in JSON (§2.2)", () => {
  test("base64 of a schema-only stream decodes", () => {
    const bytes = tableToIPC(new Table(table.schema), "stream");
    const base64 = btoa(String.fromCharCode(...bytes));
    expect(decodeSchema(base64)!.fields.map((f) => f.name)).toEqual(["a", "s"]);
    expect(decodeSchema(null)).toBeUndefined();
    expect(() => decodeSchema("not base64!")).toThrow(expect.objectContaining({ code: ErrorCode.protocolError }));
  });
});

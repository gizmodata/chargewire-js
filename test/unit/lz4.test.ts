import { readFileSync } from "node:fs";

import { MessageReader, type Table, tableFromIPC } from "apache-arrow";
import { beforeAll, describe, expect, test } from "vitest";

import { enableCodec } from "../../src/compression.js";
import { decodeLz4Frame, xxh32 } from "../../src/lz4.js";

// Fixtures made by real LZ4 implementations (the lz4 CLI and Arrow C++): see
// fixtures/lz4/make.py.
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/lz4/${name}`, import.meta.url)));

/** The bytes make.py compressed: 70,000 incompressible, 150,000 of words, 90,000 zeros, a 40-byte pattern. */
function plaintext(): Uint8Array {
  const out: number[] = [];
  let x = 1;
  const rand = (): number => {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    return x >>> 16;
  };
  for (let i = 0; i < 70_000; i++) out.push(rand() & 0xff);
  const words = ["warp", "sql", "arrow", "lz4", "frame", "block", "hardcharger", "duckdb", "zstd", "batch"];
  while (out.length < 220_000) for (const c of `${words[rand() % words.length]} `) out.push(c.charCodeAt(0));
  for (let i = 0; i < 90_000; i++) out.push(0);
  for (let r = 0; r < 1500; r++) for (let i = 0; i < 40; i++) out.push(i);
  return Uint8Array.from(out);
}

/** The frame's flags and its blocks' sizes, read independently of the decoder, to show what a fixture exercises. */
function describeFrame(frame: Uint8Array): { flg: number; blockMaxId: number; stored: number; compressed: number } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  expect(view.getUint32(0, true)).toBe(0x184d2204);
  const flg = frame[4]!;
  let p = 7 + (flg & 0x08 ? 8 : 0) + (flg & 0x01 ? 4 : 0);
  let stored = 0;
  let compressed = 0;
  for (let word = view.getUint32(p, true); word !== 0; word = view.getUint32(p, true)) {
    if (word & 0x80000000) stored++;
    else compressed++;
    p += 4 + (word & 0x7fffffff) + (flg & 0x10 ? 4 : 0);
  }
  return { flg, blockMaxId: (frame[5]! >> 4) & 7, stored, compressed };
}

const expected = plaintext();

describe("LZ4 frame decoder", () => {
  test("XXH32 matches the reference values", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(xxh32(new Uint8Array(0), 0, 0)).toBe(0x02cc5d05);
    expect(xxh32(bytes("a"), 0, 1)).toBe(0x550d7456);
    expect(xxh32(bytes("abc"), 0, 3)).toBe(0x32d153ff);
    const long = bytes("Nobody inspects the spammish repetition");
    expect(xxh32(long, 0, long.length)).toBe(0xe2293b2f);
  });

  test("Arrow C++'s frames: linked 64 KiB blocks, stored blocks among them, no checksums", () => {
    const frame = fixture("arrow.lz4");
    const shape = describeFrame(frame);
    expect(shape.flg & 0x20).toBe(0); // linked
    expect(shape.flg & 0x1c).toBe(0); // no block checksum, content size or content checksum
    expect(shape.blockMaxId).toBe(4); // 64 KiB
    expect(shape.stored).toBeGreaterThan(0);
    expect(shape.compressed).toBeGreaterThan(0);
    const out = decodeLz4Frame(frame);
    expect(out.byteOffset % 8).toBe(0);
    expect(out).toEqual(expected);
  });

  test("independent blocks with block checksums, content size and content checksum (lz4 CLI)", () => {
    const frame = fixture("independent_checksums.lz4");
    const shape = describeFrame(frame);
    expect(shape.flg & 0x3c).toBe(0x3c); // independent, block checksum, content size, content checksum
    expect(shape.stored).toBeGreaterThan(0);
    expect(decodeLz4Frame(frame)).toEqual(expected);
  });

  test("linked 256 KiB blocks without a content checksum (lz4 CLI)", () => {
    const frame = fixture("linked_256k_no_checksum.lz4");
    const shape = describeFrame(frame);
    expect(shape.flg & 0x3c).toBe(0);
    expect(shape.blockMaxId).toBe(5);
    expect(decodeLz4Frame(frame)).toEqual(expected);
  });

  test("empty content, with and without a content checksum, and empty input", () => {
    expect(decodeLz4Frame(fixture("empty.lz4")).length).toBe(0);
    expect(decodeLz4Frame(fixture("arrow_empty.lz4")).length).toBe(0);
    expect(decodeLz4Frame(new Uint8Array(0)).length).toBe(0);
  });

  test("concatenated frames and skippable frames", () => {
    const a = fixture("arrow.lz4");
    const b = fixture("independent_checksums.lz4");
    const skip = Uint8Array.from([0x5a, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
    const all = new Uint8Array(a.length + skip.length + b.length);
    all.set(a, 0);
    all.set(skip, a.length);
    all.set(b, a.length + skip.length);
    const out = decodeLz4Frame(all);
    expect(out.length).toBe(2 * expected.length);
    expect(out.subarray(0, expected.length)).toEqual(expected);
    expect(out.subarray(expected.length)).toEqual(expected);
  });

  test("a small result is not held in a block-sized buffer", () => {
    // Four literals in one compressed block of a 64 KiB frame: the bound is 64 KiB, the answer is trimmed.
    const header = [0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82];
    const frame = Uint8Array.from([...header, 5, 0, 0, 0, 0x40, 1, 2, 3, 4, 0, 0, 0, 0]);
    const out = decodeLz4Frame(frame);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(out.buffer.byteLength).toBe(4);
  });

  test("corrupt input throws instead of returning wrong bytes", () => {
    const flip = (frame: Uint8Array, at: number): Uint8Array => {
      const copy = frame.slice();
      copy[at]! ^= 0x01;
      return copy;
    };
    const checked = fixture("independent_checksums.lz4");
    expect(() => decodeLz4Frame(flip(checked, 0))).toThrow(/magic/);
    expect(() => decodeLz4Frame(flip(checked, 6 + 8))).toThrow(/header checksum/); // the HC byte after the content size
    expect(() => decodeLz4Frame(flip(checked, 40))).toThrow(/block checksum/);
    expect(() => decodeLz4Frame(flip(checked, checked.length - 1))).toThrow(/content checksum/);
    const unchecked = fixture("arrow.lz4");
    expect(() => decodeLz4Frame(unchecked.subarray(0, unchecked.length - 100))).toThrow(/truncated/);
    expect(() => decodeLz4Frame(unchecked.subarray(0, 5))).toThrow(/truncated/);
    // A match reaching back before the frame's start (offset 256 at output position 4)...
    const header = [0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82];
    const block = (offset: number) => [9, 0, 0, 0, 0x40, 1, 2, 3, 4, offset & 0xff, offset >> 8, 0x10, 5, 0, 0, 0, 0];
    expect(() => decodeLz4Frame(Uint8Array.from([...header, ...block(256)]))).toThrow(/offset/);
    // ...and its positive twin: offset 4 repeats the four literals.
    expect(Array.from(decodeLz4Frame(Uint8Array.from([...header, ...block(4)])))).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 5]);
  });
});

describe("LZ4_FRAME Arrow IPC (§8.2)", () => {
  beforeAll(async () => {
    await enableCodec("lz4_frame");
  });

  test("a stream Arrow C++ wrote with LZ4_FRAME reads back exactly", () => {
    const table = tableFromIPC(fixture("pyarrow_lz4.arrows"));
    expect(compressedCodecs(fixture("pyarrow_lz4.arrows"))).toEqual(new Set([0]));
    expect(table.numRows).toBe(3000);
    expect(table.batches.length).toBe(3);
    const n = 3000;
    expect(Array.from(table.getChild("i")!, Number)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(Array.from(table.getChild("d")!)).toEqual(Array.from({ length: n }, (_, i) => i * 1.5));
    expect(Array.from(table.getChild("s")!)).toEqual(
      Array.from({ length: n }, (_, i) => (i % 3 === 0 ? null : `v${i}`)),
    );
    expect(Array.from(table.getChild("b")!)).toEqual(Array.from({ length: n }, (_, i) => i % 2 === 0));
  });

  test("a server's stream with buffers left uncompressed (length -1) reads back exactly", () => {
    // Hardcharger's answer to SELECT i, hash(i)::DOUBLE AS h, CASE WHEN i % 3 = 0 THEN NULL
    // ELSE i END AS n, 'v' || i AS s FROM range(2000) t(i), with Warp-IPC-Compression: lz4_frame.
    const bytes = fixture("server_lz4_frame.arrows");
    const prefixes = bufferPrefixes(bytes);
    expect(prefixes.filter((p) => p === -1).length).toBeGreaterThan(0); // the incompressible doubles
    expect(prefixes.filter((p) => p > 0).length).toBeGreaterThan(0);
    const table: Table = tableFromIPC(bytes);
    expect(table.numRows).toBe(2000);
    expect(Array.from(table.getChild("i")!, Number)).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    expect(Array.from(table.getChild("n")!, (v) => (v === null ? null : Number(v)))).toEqual(
      Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? null : i)),
    );
    expect(Array.from(table.getChild("s")!)).toEqual(Array.from({ length: 2000 }, (_, i) => `v${i}`));
    const h = table.getChild("h")!.toArray() as Float64Array;
    expect(h.length).toBe(2000);
    expect(new Set(h).size).toBe(2000); // hashes, not zeros or garbage
  });
});

/** The compression codecs of a stream's record batches. */
function compressedCodecs(bytes: Uint8Array): Set<number> {
  const codecs = new Set<number>();
  const reader = new MessageReader(bytes);
  for (let m = reader.readMessage(); m !== null; m = reader.readMessage()) {
    reader.readMessageBody(m.bodyLength);
    if (m.isRecordBatch()) codecs.add(m.header().compression?.type ?? -1);
  }
  return codecs;
}

/** Each non-empty buffer's uncompressed-length prefix in a compressed stream (-1: left uncompressed). */
function bufferPrefixes(bytes: Uint8Array): number[] {
  const out: number[] = [];
  const reader = new MessageReader(bytes);
  for (let m = reader.readMessage(); m !== null; m = reader.readMessage()) {
    const body = reader.readMessageBody(m.bodyLength);
    if (!m.isRecordBatch()) continue;
    for (const { offset, length } of m.header().buffers) {
      if (length === 0) continue;
      out.push(Number(new DataView(body.buffer, body.byteOffset + offset, 8).getBigInt64(0, true)));
    }
  }
  return out;
}

// Licensed under the Apache License, Version 2.0.

/**
 * An LZ4 frame decoder (https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md) for
 * Arrow's LZ4_FRAME buffer compression (§8.2). Arrow C++ writes one frame per buffer,
 * with linked 64 KiB blocks and no checksums; this reads any frame the format allows:
 * linked or independent blocks of any size, stored (uncompressed) blocks, content size,
 * dictionary id (a frame that needs the dictionary is refused), block and content
 * checksums (verified), concatenated and skippable frames. Corrupt input throws; it never
 * returns wrong bytes it could have noticed.
 *
 * Loaded only when a connection uses `lz4_frame`, so it costs nothing otherwise.
 */

const frameMagic = 0x184d2204;
const skippableMagicMask = 0xfffffff0;
const skippableMagic = 0x184d2a50;
const storedBit = 0x80000000;
const minMatch = 4;
const maxExpansion = 255;

function corrupt(detail: string): Error {
  return new Error(`invalid LZ4 frame: ${detail}`);
}

function u32(src: Uint8Array, at: number): number {
  return (src[at]! | (src[at + 1]! << 8) | (src[at + 2]! << 16) | (src[at + 3]! << 24)) >>> 0;
}

/** One frame's descriptor and where its blocks are, from a first pass over the input. */
interface Frame {
  independent: boolean;
  blockChecksum: boolean;
  contentChecksum: boolean;
  contentSize: number | undefined;
  hasDictionary: boolean;
  blockMax: number;
  /** Offset of the first block's size field. */
  blocks: number;
}

/** Decodes an LZ4 frame (or several concatenated). The result starts at byte offset 0. */
export function decodeLz4Frame(src: Uint8Array): Uint8Array {
  // First pass: check the structure and bound the output, so it is allocated once.
  const frames: Frame[] = [];
  let bound = 0;
  let pos = 0;
  while (pos < src.length) {
    if (pos + 4 > src.length) throw corrupt("truncated magic number");
    const magic = u32(src, pos);
    if ((magic & skippableMagicMask) >>> 0 === skippableMagic) {
      if (pos + 8 > src.length) throw corrupt("truncated skippable frame");
      pos += 8 + u32(src, pos + 4);
      if (pos > src.length) throw corrupt("truncated skippable frame");
      continue;
    }
    if (magic !== frameMagic) throw corrupt(`bad magic number 0x${magic.toString(16)}`);
    const frame = readDescriptor(src, pos + 4);
    frames.push(frame);
    pos = frame.blocks;
    let blocksBound = 0;
    for (;;) {
      if (pos + 4 > src.length) throw corrupt("truncated block size");
      const word = u32(src, pos);
      pos += 4;
      if (word === 0) break;
      const size = (word & ~storedBit) >>> 0;
      if (size > frame.blockMax) throw corrupt(`block of ${size} bytes in a frame of ${frame.blockMax}-byte blocks`);
      pos += size + (frame.blockChecksum ? 4 : 0);
      if (pos > src.length) throw corrupt("truncated block");
      // A compressed byte decodes to at most 255 (a match-length byte adds 255), so a short
      // block does not reserve a whole block's room.
      blocksBound += word & storedBit ? size : Math.min(frame.blockMax, size * maxExpansion);
    }
    if (frame.contentChecksum) pos += 4;
    if (pos > src.length) throw corrupt("truncated content checksum");
    if (frame.contentSize !== undefined) {
      if (frame.contentSize > blocksBound) throw corrupt("content size larger than its blocks can hold");
      bound += frame.contentSize;
    } else {
      bound += blocksBound;
    }
  }

  // Second pass: decode every block into one buffer.
  const out = new Uint8Array(bound);
  let op = 0;
  for (const frame of frames) {
    const frameStart = op;
    pos = frame.blocks;
    for (;;) {
      const word = u32(src, pos);
      pos += 4;
      if (word === 0) break;
      const size = (word & ~storedBit) >>> 0;
      if (frame.blockChecksum && xxh32(src, pos, pos + size) !== u32(src, pos + size)) {
        throw corrupt("block checksum mismatch");
      }
      const limit = Math.min(op + frame.blockMax, out.length);
      if (word & storedBit) {
        if (op + size > limit) throw corrupt("content larger than its content size");
        out.set(src.subarray(pos, pos + size), op);
        op += size;
      } else {
        op = decodeBlock(src, pos, pos + size, out, op, limit, frame.independent ? op : frameStart);
      }
      pos += size + (frame.blockChecksum ? 4 : 0);
    }
    if (frame.contentSize !== undefined && op - frameStart !== frame.contentSize) {
      throw corrupt(`content of ${op - frameStart} bytes, the frame says ${frame.contentSize}`);
    }
    if (frame.contentChecksum) {
      if (xxh32(out, frameStart, op) !== u32(src, pos)) throw corrupt("content checksum mismatch");
    }
  }
  // Keep the bound's spare room only when it is small next to the content.
  if (op === out.length) return out;
  return out.length - op <= op >>> 3 ? out.subarray(0, op) : out.slice(0, op);
}

function readDescriptor(src: Uint8Array, at: number): Frame {
  if (at + 3 > src.length) throw corrupt("truncated frame descriptor");
  const flg = src[at]!;
  const bd = src[at + 1]!;
  if (flg >>> 6 !== 1) throw corrupt(`unsupported version ${flg >>> 6}`);
  if (flg & 0x02 || bd & 0x8f) throw corrupt("reserved bits set");
  const blockId = (bd >>> 4) & 7;
  if (blockId < 4) throw corrupt(`bad block maximum size id ${blockId}`);
  let p = at + 2;
  let contentSize: number | undefined;
  if (flg & 0x08) {
    if (p + 8 > src.length) throw corrupt("truncated content size");
    const high = u32(src, p + 4);
    if (high > 0x1fffff) throw corrupt("content size too large");
    contentSize = high * 0x100000000 + u32(src, p);
    p += 8;
  }
  const hasDictionary = (flg & 0x01) !== 0;
  if (hasDictionary) p += 4;
  if (p + 1 > src.length) throw corrupt("truncated frame descriptor");
  if (((xxh32(src, at, p) >>> 8) & 0xff) !== src[p]) throw corrupt("header checksum mismatch");
  return {
    independent: (flg & 0x20) !== 0,
    blockChecksum: (flg & 0x10) !== 0,
    contentChecksum: (flg & 0x04) !== 0,
    contentSize,
    hasDictionary,
    blockMax: 1 << (8 + 2 * blockId),
    blocks: p + 1,
  };
}

/**
 * Decodes one LZ4 block (src[ip, end)) into out at op, writing no further than limit;
 * matches reach back no further than windowStart. Returns the new output position.
 */
function decodeBlock(
  src: Uint8Array,
  ip: number,
  end: number,
  out: Uint8Array,
  op: number,
  limit: number,
  windowStart: number,
): number {
  for (;;) {
    const token = src[ip++]!;
    let length = token >>> 4;
    if (length === 15) {
      let b: number;
      do {
        if (ip >= end) throw corrupt("truncated literal length");
        b = src[ip++]!;
        length += b;
      } while (b === 255);
    }
    if (length > 0) {
      if (ip + length > end) throw corrupt("literals run past the block");
      if (op + length > limit) throw corrupt("output larger than the block size");
      if (length < 32) {
        for (let k = 0; k < length; k++) out[op + k] = src[ip + k]!;
      } else {
        out.set(src.subarray(ip, ip + length), op);
      }
      ip += length;
      op += length;
    }
    if (ip === end) return op; // the last sequence has literals only
    if (ip + 2 > end) throw corrupt("truncated match offset");
    const offset = src[ip]! | (src[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || op - offset < windowStart) throw corrupt("match offset out of range");
    length = (token & 15) + minMatch;
    if (length === 15 + minMatch) {
      let b: number;
      do {
        if (ip >= end) throw corrupt("truncated match length");
        b = src[ip++]!;
        length += b;
      } while (b === 255);
    }
    if (op + length > limit) throw corrupt("output larger than the block size");
    let from = op - offset;
    if (length < 32 || (offset < length && offset < 32)) {
      const stop = op + length;
      while (op < stop) out[op++] = out[from++]!;
    } else if (offset >= length) {
      out.copyWithin(op, from, from + length);
      op += length;
    } else {
      // The match overlaps itself: a pattern of `offset` bytes repeated. Copy it in
      // doubling chunks, each starting a whole number of periods in.
      for (let done = 0; done < length;) {
        const n = Math.min(offset + done, length - done);
        out.copyWithin(op + done, from, from + n);
        done += n;
      }
      op += length;
    }
  }
}

const P1 = 0x9e3779b1 | 0;
const P2 = 0x85ebca77 | 0;
const P3 = 0xc2b2ae3d | 0;
const P4 = 0x27d4eb2f | 0;
const P5 = 0x165667b1 | 0;

const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r));
const round = (acc: number, input: number): number => Math.imul(rotl((acc + Math.imul(input, P2)) | 0, 13), P1);

/** XXH32 with seed 0 of p[start, end): LZ4's checksum. */
export function xxh32(p: Uint8Array, start: number, end: number): number {
  let i = start;
  let h: number;
  if (end - start >= 16) {
    let v1 = (P1 + P2) | 0;
    let v2 = P2;
    let v3 = 0;
    let v4 = -P1 | 0;
    for (const last = end - 16; i <= last; i += 16) {
      v1 = round(v1, u32(p, i));
      v2 = round(v2, u32(p, i + 4));
      v3 = round(v3, u32(p, i + 8));
      v4 = round(v4, u32(p, i + 12));
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    h = P5;
  }
  h = (h + (end - start)) | 0;
  for (; i + 4 <= end; i += 4) h = Math.imul(rotl((h + Math.imul(u32(p, i), P3)) | 0, 17), P4);
  for (; i < end; i++) h = Math.imul(rotl((h + Math.imul(p[i]!, P5)) | 0, 11), P1);
  h ^= h >>> 15;
  h = Math.imul(h, P2);
  h ^= h >>> 13;
  h = Math.imul(h, P3);
  h ^= h >>> 16;
  return h >>> 0;
}

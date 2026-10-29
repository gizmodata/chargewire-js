// Licensed under the Apache License, Version 2.0.

import { CompressionType, compressionRegistry } from "apache-arrow";

import { Capability } from "./protocol.js";

/** What a connection or call asks for (`ipcCompression`). */
export type IpcCompression = "none" | "lz4_frame" | "zstd" | "auto";
/** A codec named as in §8.2 and the Chargewire-IPC-Compression header. */
export type IpcCodec = "lz4_frame" | "zstd";

export const ipcCompressions: readonly IpcCompression[] = ["none", "lz4_frame", "zstd", "auto"];

/**
 * The round trip from which `auto` uses zstd: a link that slow is a WAN, where bandwidth,
 * not CPU, limits a transfer. Below it `auto` uses lz4_frame. The same rule as the Go
 * ADBC driver.
 */
export const farLinkMs = 10;

const codecCapability: Record<IpcCodec, string> = {
  lz4_frame: Capability.ipcCompressionLz4Frame,
  zstd: Capability.ipcCompressionZstd,
};

/** The codec `auto` uses on a link with this round trip. */
export function autoCodec(rttMs: number): IpcCodec {
  return rttMs >= farLinkMs ? "zstd" : "lz4_frame";
}

/**
 * The codec to ask for, or undefined for none: the setting's codec when the server lists
 * its capability, and for `auto` the one that suits the link (if the server lists it).
 * A codec the server does not list is never used.
 */
export function chooseCodec(
  setting: IpcCompression,
  has: (capability: string) => boolean,
  rttMs: number,
): IpcCodec | undefined {
  if (setting === "none") return undefined;
  const codec = setting === "auto" ? autoCodec(rttMs) : setting;
  return has(codecCapability[codec]) ? codec : undefined;
}

const enabled = new Map<IpcCodec, Promise<void>>();

/**
 * Lets Arrow read buffers compressed with `codec` (§8.2), loading its decoder only when
 * asked for: fzstd (pure JavaScript; Arrow JS has no zstd of its own) or this package's
 * LZ4 frame decoder. A codec the application has registered already is kept.
 *
 * Arrow JS 21 hands a codec's output straight to typed-array views, which need 8-byte
 * aligned offsets, and fzstd may return a view at any offset: such output is copied.
 */
export function enableCodec(codec: IpcCodec): Promise<void> {
  let done = enabled.get(codec);
  if (done === undefined) {
    done = codec === "zstd" ? registerZstd() : registerLz4();
    enabled.set(codec, done);
  }
  return done;
}

async function registerZstd(): Promise<void> {
  const existing = compressionRegistry.get(CompressionType.ZSTD);
  if (typeof existing?.decode === "function") return;
  const { decompress } = await import("fzstd");
  compressionRegistry.set(CompressionType.ZSTD, {
    ...existing,
    decode(data: Uint8Array): Uint8Array {
      const out = decompress(data);
      return out.byteOffset % 8 === 0 ? out : out.slice();
    },
  });
}

async function registerLz4(): Promise<void> {
  const existing = compressionRegistry.get(CompressionType.LZ4_FRAME);
  if (typeof existing?.decode === "function") return;
  const { decodeLz4Frame } = await import("./lz4.js");
  compressionRegistry.set(CompressionType.LZ4_FRAME, { ...existing, decode: decodeLz4Frame });
}

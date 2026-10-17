// Licensed under the Apache License, Version 2.0.

import { CompressionType, compressionRegistry } from "apache-arrow";

let enabled: Promise<void> | undefined;

/**
 * Lets Arrow read ZSTD-compressed IPC buffers (§8.2), with fzstd (pure JavaScript, loaded
 * only when asked for). Arrow JS has no zstd of its own; a codec the application has
 * registered already is kept.
 *
 * Arrow JS 21 hands a codec's output straight to typed-array views, which need 8-byte
 * aligned offsets, and fzstd may return a view at any offset: such output is copied.
 */
export function enableZstd(): Promise<void> {
  enabled ??= (async () => {
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
  })();
  return enabled;
}

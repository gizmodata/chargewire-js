// Licensed under the Apache License, Version 2.0.

import type { Platform, TlsOptions } from "./types.js";

/** Node, Deno and Bun: undici's fetch carries the TLS settings. */
export const platform: Platform = {
  name: "node",
  defaultResultPartitions: 8,
  streamingUploads: true,
  async tlsFetch(tls: TlsOptions): Promise<typeof fetch> {
    // Loaded only when TLS settings are given, so plain use never loads undici.
    const undici = await import("undici");
    const agent = new undici.Agent({
      connect: {
        ...(tls.ca !== undefined ? { ca: typeof tls.ca === "string" ? tls.ca : [...tls.ca] } : {}),
        ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
        ...(tls.key !== undefined ? { key: tls.key } : {}),
        ...(tls.servername !== undefined ? { servername: tls.servername } : {}),
        rejectUnauthorized: tls.skipVerify !== true,
        // With a client certificate, never resume TLS sessions: servers built on the
        // warp-sql SDK (warp-duckdb, Hardcharger 0.2) verify client certificates without
        // an OpenSSL session id context, so every resumed handshake fails ("tlsv1 alert
        // internal error") and only each host's first connection would work.
        ...(tls.cert !== undefined ? { maxCachedSessions: 0 } : {}),
      },
    });
    const undiciFetch = undici.fetch as unknown as (
      input: RequestInfo | URL,
      init?: RequestInit & { dispatcher?: unknown },
    ) => Promise<Response>;
    return (input: RequestInfo | URL, init?: RequestInit) => undiciFetch(input, { ...init, dispatcher: agent });
  },
};

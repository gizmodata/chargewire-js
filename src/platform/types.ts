// Licensed under the Apache License, Version 2.0.

/**
 * TLS settings for Node, Deno and Bun (browsers and edge runtimes use the platform's
 * trust store and cannot change it). Values are PEM text.
 */
export interface TlsOptions {
  /** CA certificates to trust instead of the system's. */
  ca?: string | readonly string[];
  /** Client certificate chain, for mutual TLS. */
  cert?: string;
  /** Client private key, for mutual TLS. */
  key?: string;
  /** Host name the server certificate is checked against (default: the URL's host). */
  servername?: string;
  /** Do not verify the server's certificate (development only). */
  skipVerify?: boolean;
}

/** What differs between Node-like runtimes and browsers/edge runtimes. */
export interface Platform {
  readonly name: "node" | "web";
  /**
   * How many partitions of a result to read at once by default (§6.10). Browsers and
   * Cloudflare Workers allow about six connections per host over HTTP/1.1, and a split
   * result needs one per partition plus room for control requests.
   */
  readonly defaultResultPartitions: number;
  /** Whether request bodies may stream (chunked); browsers need HTTP/2 for that, Safari never. */
  readonly streamingUploads: boolean;
  /** A fetch that applies the TLS settings. */
  tlsFetch(tls: TlsOptions): Promise<typeof fetch>;
}

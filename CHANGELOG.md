# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `@gizmodata/warp-sql`: a TypeScript client for the Warp SQL protocol (draft 0.1.0) over plain
  `fetch` and Apache Arrow, for Node 22.19+, browsers, Deno, Bun and Cloudflare Workers. ESM and
  CJS builds with types; a `node` build (TLS options through undici, streamed uploads, 8
  partitions) and a `default` build for browsers and edge runtimes (4 partitions), chosen by
  export conditions. `apache-arrow` 21 is a peer dependency.
- `connect` with a password, an access token, a token provider or an identity provider's token
  (`token_exchange`); `warp://`, `https://` and `http://` URLs, with schemes a wrapper can add.
- `query` (an Arrow Table), `stream` (an async iterator of RecordBatches with backpressure),
  `execute` (rows changed), prepared statements with JSON or Arrow parameters and
  `executeBatch`, bulk `ingest` from Tables, batches or (async) iterables, catalog `metadata`
  including `columns`, transactions, session options and `close`.
- Streams are complete only with Arrow's end-of-stream marker; retained results resume from the
  next batch; partitioned results (§6.10) are read concurrently and merged in order; requests
  carry Idempotency-Keys and are retried safely; tokens are renewed; lost sessions are replaced
  with their options; an `AbortSignal` cancels the statement on the server (by id, through the
  session, or by resending with the Idempotency-Key); zstd result buffers through fzstd.
- Typed `WarpSqlError` with the problem document's code, status, SQLSTATE, detail and request id.
- Tests: unit tests with an in-process fake server, live tests against warp-duckdb and Hardcharger
  (failing, never skipping, without a server, and when no test reached one), Node/Deno/Bun/workerd
  smoke tests, and Chromium/WebKit tests of the example page. CI against the Hardcharger image;
  a tag-triggered release gated on the full suite, with npm trusted publishing prepared but off.

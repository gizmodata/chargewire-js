# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- LZ4_FRAME result compression (spec §8.2): `ipcCompression: "lz4_frame"`, read by a dependency-free
  LZ4 frame decoder in this package that is loaded only when a connection uses it (3.7 KiB
  minified). It decodes Arrow's LZ4 buffers at 850 to 900 MB/s in Node, against about 240 MB/s for
  zstd through fzstd.
- `ipcCompression: "auto"`: `lz4_frame` when the discovery request's round trip is under 10 ms, else
  `zstd`, the Go ADBC driver's rule. A first discovery that looks slow is timed again on the open
  connection, so connection setup does not count as distance.

### Changed

- `ipcCompression` takes `"none"`, `"lz4_frame"`, `"zstd"` or `"auto"`, and a codec is used only
  when the server lists its capability (`ipc_compression_lz4_frame`, `ipc_compression_zstd`). The
  chosen codec is sent in `Warp-IPC-Compression` on every request that returns Arrow: the submit,
  each partition's result request, and catalog metadata requests (these had no header).

- The README points Hardcharger users to `@gizmodata/hardcharger` (gizmodata/hardcharger-js), the
  `hardcharger://` client built on this package, instead of saying such a wrapper is planned.

### Fixed

- An explicit port 443 was dropped from a plain-HTTP URL: `warp://host:443?tls=false` and
  `http://host:443` dialled port 80, and a wrapper's scheme with a default port of its own
  (`hardcharger://host:443`) dialled that default instead of 443. The URL is parsed as https,
  which drops 443 as its default; the port is now taken from the URL's text.
- A Number beyond `Number.MAX_SAFE_INTEGER` in JSON parameters (or any JSON body) is written in
  exponent form, so the server reads exactly that double. `JSON.stringify` wrote `2 ** 63` as
  `9223372036854776000`, another integer, which a server that binds wide integers exactly (spec
  §6.1, warp-sql fc0c683) bound as that integer. Bigints were and are written as exact integers of
  any size.
- Arrow parameter rows (`executeBatch`, a prepared statement run with plain values) refuse an
  integer that does not fit its parameter's type, a fraction for an integer type, and a Number
  beyond the safe integers, instead of letting Arrow JS wrap or truncate it (`2n ** 63n` into a
  BIGINT was written as `-2n ** 63n`, `300` into a UTINYINT as `44`, `1.5` into an INTEGER as `1`);
  an untyped bigint beyond 64 bits is refused too. Numbers now bind to 64-bit integer parameters
  (they were refused by Arrow JS) and bigints to narrower ones.
- Tests: live tests that wide integer parameters come back exact or are refused (§6.1), that a
  Number beyond the safe integers binds as its double, that `executeBatch` refuses an integer its
  parameter can't hold, and (Hardcharger, which can `KILL SESSION`) that a killed session is
  `session_ended` with reason `killed` for a statement and for `getSession()` (spec §5.2), with no
  new token and no replacement. It replaces a test that asserted nothing about a server. CI's live
  suites run against `hardcharger:main` (0.2.0 rounds wide integers and answers that GET with 200).
- The bigint placeholders in JSON bodies carry a random tag: a string parameter that spelled the
  old fixed placeholder (`"\u0000bigint0\u0000"`) was sent as a number.

### Added

- Client certificate sign-in (spec §4.4): `connect({ authType: "client_certificate" })` sends the
  `client_certificate` grant, with no password, and renews the certificate-bound token with it. In
  Node, Deno and Bun the certificate is `tls.cert`/`tls.key`, presented by the connection's one undici
  dispatcher on every connection, split-result partitions included; in a browser it is the user's,
  and requests go with `credentials: "include"` (new option `fetchCredentials` to choose another
  mode). Refused before anything is sent: a username, password or token beside it, plain HTTP, or
  (Node) no client certificate; refused after discovery: a server without capability
  `mtls_identity` and the grant (`not_implemented`). `tls.cert` without `tls.key` (or the reverse)
  is refused too.
- `ErrorCode` has the certificate codes `client_certificate_required`,
  `unknown_certificate_identity`, `certificate_revoked`, `certificate_mismatch` and
  `certificate_identity_mismatch` (none renews the token), and `unsupported_grant_type`;
  `Capability.mtlsIdentity`.
- Tests: unit tests (the grant and its renewal, every refusal, each certificate code at sign-in and
  later, the browser build's credentials mode), live tests on warp-duckdb and Hardcharger
  (`test/live/mtls.test.ts`: sign-in with a split result and an upload, an unknown identity, a bound
  token over another certificate and its twin, a grant without a certificate, identity match, a
  server with certificate sign-in off), and `npm run test:browser:mtls`, Chromium and WebKit signing
  in from a page on another origin, which fails on servers that don't send
  `Access-Control-Allow-Credentials`.

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

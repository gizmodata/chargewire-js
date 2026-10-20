# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Warp SQL protocol 1.0.0 (warp-sql spec 1.0.0): the client follows the stable version 1.
- `ErrorCode.partitionNotFound` (`partition_not_found`, §6.4), `ErrorCode.internalError`
  (`internal_error`, 500) and `ErrorCode.clientHttpError` (`client_http_error`, an error answer
  without a problem document, such as a proxy's page; `status` says what it was). `ErrorCode` now
  lists every server code of version 1, and a unit test keeps it so.
- `Capability.resultLocations` (`result_locations`). On a server that lists `result_locations` the
  client sends `Warp-Result-Locations: remote` and reads partitions from their locations; it never
  sends the header otherwise, and a partition with a location it did not ask for is a
  `client_protocol_error`.
- Types `InvalidTokenReason`, `CancelReason` and `ServerInfo` (the frozen version 1 keys of
  `GET …/metadata/server-info`: `server_name`, `server_version`, `server_arrow_version`,
  `server_read_only`, `sql_identifier_quote_char`, `sql_transactions_supported`; a missing key is
  unknown). `conn.metadata.serverInfo()` returns `ServerInfo`. `SessionEndedReason` gains
  `token_revoked`.
- `version`, the package's version. In Node, Deno and Bun every request sends
  `User-Agent: warp-sql-js/<version>` unless `userAgent` says otherwise (browsers set their own).
- A TLS alert `certificate_required` or `certificate_revoked` from the server's handshake is
  reported with that code (§4.4), not as a transport error.
- Tests: unit tests for each 1.0 behaviour (invalid_token and session_ended reasons, unknown
  states, transaction values, cancel reasons, result kinds and capabilities, the 409/422 submit
  errors, split results without an order, remote partitions read at once and only when asked for,
  the query tag's escaping and size, client code names, User-Agent); live tests that a runtime
  failure is `execution_error` with status 422 on both submit paths, that server-info has the
  frozen keys with their types and none of the removed ones, and that a non-ASCII query tag is
  accepted.
- Browser sign-in (warp-sql spec §4.3, capability `oauth_browser`): `connect({ authType:
  "oauth_browser", openUrl })` signs in with the server's identity provider through a browser and
  refuses a server without the capability before creating a flow; `browserSignIn` does it
  without a connection; `startBrowserSignIn` (optional `returnTo`), `pollBrowserSignIn` (the
  poll secret in the JSON body, never a URL or header; a failed flow throws its code) and
  `takeBrowserSignInFlowId` are the steps; `beginBrowserRedirectSignIn` and
  `completeBrowserRedirectSignIn` serve web pages that come back to themselves (the secret in
  this tab's `sessionStorage`, the flow id read from and removed from the fragment, flows the tab
  did not start ignored); `browserSignInProvider(discovery)` gives the provider's name. New error
  codes `flow_not_found`, `invalid_return_to`, `access_denied`, `identity_provider_error`. Unit
  tests (13) and live tests (4) against `warp-duckdb` with a mock OpenID Connect provider
  (`test/live/idp.ts`; server flags in `WARP_SQL_JS_TEST_SERVER_OAUTH_ARGS`).
- `conn.transactionState()` and `SessionDocument.transaction` (warp-sql spec §5.2): `none`,
  `open` or `aborted`, as the server's engine has it, so an application shows whether a
  transaction is open (from SQL `BEGIN` too, not only `setAutocommit(false)`) and whether a failed
  or cancelled statement left it needing a rollback. Exported type: `TransactionState`. Live tests:
  SQL `BEGIN`, an aborting failure and `ROLLBACK`; autocommit off and on; a streamed `BEGIN`.
- LZ4_FRAME result compression (spec §8.2): `ipcCompression: "lz4_frame"`, read by a dependency-free
  LZ4 frame decoder in this package that is loaded only when a connection uses it (3.7 KiB
  minified). It decodes Arrow's LZ4 buffers at 850 to 900 MB/s in Node, against about 240 MB/s for
  zstd through fzstd.
- `ipcCompression: "auto"`: `lz4_frame` when the discovery request's round trip is under 10 ms, else
  `zstd`, the Go ADBC driver's rule. A first discovery that looks slow is timed again on the open
  connection, so connection setup does not count as distance.

### Changed

- **Breaking: the client's own error codes begin with `client_`** (spec §11), and their
  `ErrorCode` keys with `client`: `invalid_argument` is `client_invalid_argument`
  (`ErrorCode.clientInvalidArgument`), `transport_error` is `client_transport_error`
  (`clientTransportError`), `protocol_error` is `client_protocol_error` (`clientProtocolError`),
  `incomplete_stream` is `client_incomplete_stream` (`clientIncompleteStream`),
  `result_buffer_exceeded` is `client_result_buffer_exceeded` (`clientResultBufferExceeded`) and
  `connection_closed` is `client_connection_closed` (`clientConnectionClosed`).
- **Breaking:** `client_certificate_required` is `certificate_required`
  (`ErrorCode.certificateRequired`), as spec 1.0.0 names it.
- **Breaking:** an error answer without a problem document is `client_http_error` with its
  `status`; the client no longer makes up a server code for it from the status (a 502 page was
  `execution_error`, a 404 page `not_found`).
- **Breaking:** `Capability.resultRetention` and `Capability.partitionedResults` are gone (spec
  1.0.0 has no such capabilities: retention is core, and the client reads `retained` before
  relying on a re-read, as it did), and so is `DiscoveryDocument.draft`.
- Browser sign-in follows the 1.0 rules: a flow state the client doesn't know is not terminal
  (it reads as `pending` and polling goes on), a failed flow's `error.code` is kept as sent even
  when the client doesn't know it, and has no `status` (it was `401`); a failed flow without a
  code is a `client_protocol_error` (it was `invalid_credentials`), and an answer without a state
  too. A sign-in not completed in time is `client_sign_in_timeout`
  (`ErrorCode.clientSignInTimeout`; it was `statement_timeout`).
- `invalid_token` is renewed (once) only without a reason, with `token_expired` or with a reason
  the client doesn't know (§4.2). After `token_revoked`, `credentials_changed` or
  `principal_dropped` the client does not sign in again on its own; the error carries the reason.
  It used to sign in again whatever the reason.
- `session_ended` (§5.6): a session ended for an expired token is replaced only when the client
  can get a new token (not with a fixed `token`), and the client signs in once, not twice, when the
  request had already renewed its token after `invalid_token`. Other reasons, and reasons the
  client doesn't know, are the error, as before.
- Open enumerations (§12): an unknown statement state is not final (the client keeps polling), an
  unknown `reason` or `cancel_reason` is kept as sent, an unknown session `transaction` is reported
  as `"unknown"` (`TransactionState` gains it), and a result `kind` the client didn't ask for is a
  `client_protocol_error` instead of being read as an update count.
- A submit or execute answered with an error response for a statement that failed or was
  cancelled (spec 1.0.0: `execution_error` is 422, `statement_cancelled` and `statement_timeout`
  are 409 with `cancel_reason`) carries `statementId` (from `Warp-Statement-Id`) and
  `cancelReason`, and the statement is deleted on the server as any finished one is.
- A split result's partitions, on this server or others, are all opened at once (§6.10). Partitions
  on other servers used to be read one after another, and partition 0 was opened before the rest.
- `Warp-Query-Tag` is sent as ASCII JSON, every other character as a `\u` escape (§2.5), and a
  tag over 4,096 bytes is refused (`client_invalid_argument`) before anything is sent.
- `ipcCompression` takes `"none"`, `"lz4_frame"`, `"zstd"` or `"auto"`, and a codec is used only
  when the server lists its capability (`ipc_compression_lz4_frame`, `ipc_compression_zstd`). The
  chosen codec is sent in `Warp-IPC-Compression` on every request that returns Arrow: the submit,
  each partition's result request, and catalog metadata requests (these had no header).
- The README points Hardcharger users to `@gizmodata/hardcharger` (gizmodata/hardcharger-js), the
  `hardcharger://` client built on this package, instead of saying such a wrapper is planned.

### Fixed

- Uploads (`ingest`, Arrow parameters) from a bundled browser app. The encoder used
  `RecordBatchStreamWriter.throughDOM()`, which apache-arrow installs only as a side effect of
  its DOM entry point; it declares `"sideEffects": false`, so Vite, webpack and esbuild drop that
  and every upload failed with `"throughDOM" not available in this environment` (Hardcharger's
  web UI found it with its first upload). The writer is now read as an async iterable, which
  works everywhere, and the encoder holds at most about 8 MB of encoded batches ahead of the
  request instead of encoding the whole input ahead of it.
- `close()` waits for the deletes of finished statements (sent off the caller's path) before it
  ends the session. A statement run just before `close()` (a `ROLLBACK` in a `finally`, say) had
  its delete arrive after the session's and answered `404`, which a browser logs as an error.
- A streamed result split into several partitions without `Warp-Result-Order` (or with an unknown
  one) was read as `any`; it is a `client_protocol_error` (§6.10). So is a statement document with
  several partitions and no (or an unknown) `partition_order`, which was read partition after
  partition.
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

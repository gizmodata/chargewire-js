# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A session that replaces a lost one opens where the lost one was, after the current schema and
  then the current catalog were set on a connection (`setOptions({ schema: "raw" })`, or `schema`
  given to `connect`, then `setOptions({ catalog: "lake" })`). Setting the catalog moves the
  session to that catalog's default schema, as SQL `USE` does, but the client still remembered
  the schema and replayed both. The replacement opened in `lake.raw` when `lake` has a schema of
  that name, so later statements ran in another schema than before the loss, without an error.
  When it has none, no replacement could be opened: every request from then on failed
  (`opening a replacement failed: … No catalog + schema named "lake.raw" found`) and the
  connection was unusable. Every release since 1.0.0 did this. The client now forgets the schema
  when the catalog is set without one, or with a schema the server refuses (it takes the catalog
  all the same). A catalog the server refuses changes nothing, and a schema set with the catalog
  or after it is replayed as before.
- A lazy connection to a stopped server (2.3.4 and 2.3.5, which keep the options set before the
  first request) had the same fault before it opened: the schema, then the catalog, set before
  the first request were sent together, so the session opened in `lake.raw`, or that first
  request failed (`session option "schema": … No catalog + schema named "lake.raw" found`). The
  options now keep the order they were set in, as on an open session, and `setOptions` returns
  them without the forgotten schema.

A catalog and a schema given together (to `connect`, in `sessionOptions`, or in one `setOptions`
call) were never affected: they travel in one options document, and the server looks the schema
up in the catalog given with it, whichever key comes first. A live test now connects 40 times in
each form, lazy connections and a replacement session included, to keep it so.

## [2.3.5] - 2026-11-07

### Fixed

- A new connection whose first request is refused with `invalid_token` and `token_revoked` signs
  in again once, with its own method (`tokenProvider`, browser sign-in, password, token exchange),
  instead of failing. That is a token from before a person stopped the server (GizmoData Cloud
  revokes those), handed to the connection by a cache, such as a token provider's or an identity
  provider's single sign-on. A second refusal is the error. A connection the server has taken a
  request from still never signs in again on its own after `token_revoked` (§4.2). A `token` given
  to `connect` still fails, now saying it was revoked (for instance issued before the server was
  stopped) and to sign in again for a new one.

## [2.3.4] - 2026-11-07

### Changed

- Lazy connect: setting session options before the first request is not work. `setOptions` and
  `setAutocommit` on a connection made to a stopped server are kept and sent right after the
  session is created, before the first call (options given to `connect`, a `session_tag`
  included, go with the creation as before), so they no longer sign in and start the server. An
  option the server refuses is that first call's error, with the message `setOptions` gives, and
  the next call runs. `commit()` and `rollback()` before the first call end an empty transaction
  and send nothing, so `transaction()` whose work sends nothing sends nothing.

## [2.3.3] - 2026-11-07

### Added

- Lazy connect to a stopped server. When the discovery document says `"state": "stopped"` (a
  stand-in answering for a stopped server, such as GizmoData Cloud's resume holder), `connect`
  returns without signing in or opening a session: the first call that does work (a statement,
  `prepare`, metadata, an ingest, session options, a transaction call, `getSession`) signs in,
  opens the session and waits for the server to start. Until then reading the connection's
  properties and `close()` send nothing, so a connection opened for nothing (a pool refilling, an
  app that connects at startup) no longer starts a stopped server. A wrong password or an
  unreachable server is that first call's error, the one `connect` would have given. Without
  `state`, nothing changes. `sessionId` is `""` until the session opens.

## [2.3.2] - 2026-11-07

### Fixed

- `transaction()`'s clean-up (the rollback after an error, and turning autocommit back on) no
  longer signs in, opens a session or waits for a resuming server. Late in a token's life it
  renewed the token first, and that sign-in could start a server stopped while idle (§11.2). It
  now goes with the token the client has, for at most 10 s per request, and never hides the error
  `work` or the commit threw. When the server no longer has the session (or is stopped), its
  transaction is gone with it. When the clean-up can't tell (the token was refused, no answer),
  the client sends nothing more to that session (turning autocommit on with the transaction still
  open would commit it) and gives it up: the next call opens a new session, as for a lost session,
  and deletes the old one.
- Progress observations (`onProgress` polls, and the last report when a result ends) no longer
  sign in or open a session: they go with the token the client has, and a refusal only skips that
  report.

## [2.3.1] - 2026-11-06

### Fixed

- Closing a connection, statement or prepared statement, and cancelling a statement, no longer
  signs in. The client renews its access token shortly before it expires (2 minutes, or a quarter
  of its life) on whatever request comes next, so a connection closed in the last minutes of its
  token's life sent a password (or token exchange) sign-in first. A server stopped while idle and
  started again by the first sign-in (§11.2) then started for nobody, and could undo a deliberate
  stop. Closes and cancels now go with the token the client has, never renewing it before or after
  an `invalid_token` answer; a close or cancel refused with `invalid_token` counts as done, as one
  answered `session_not_found` or `server_resuming` already did, since what it ends lived only as
  long as the token. Statements, metadata and new sessions renew the token as before.

## [2.3.0] - 2026-11-06

### Added

- Optional `onProgress` callbacks observe statement execution while results stream, without forcing retention. Observer failures do not fail SQL; requests stop when results close.
- `ResultStream.statement()` reads the current statement document and preserves the last observed snapshot after release.

## [2.2.1] - 2026-11-05

### Fixed

- A request that finds its session lost no longer runs again on the replacement after the lost
  session ran a statement whose first word is `USE`, `SET`, `RESET` or `PRAGMA`. The replacement
  has the connection's options but not what SQL set, so an `INSERT INTO t` run again after a SQL
  `USE other_schema` wrote to the default schema's table, and other statements ran with other
  settings, without an error. It now fails with the lost-session error, saying that the settings
  and `USE` of the old session are gone and that it did not run again; the next call runs on the
  replacement. Only the first word of each statement counts (`UPDATE t SET ...` does not). Catalog
  and schema set through `connect` or `setOptions` are restored on the replacement, so they don't
  count, and a `USE` followed by `setOptions` with both `catalog` and `schema` counts as restored.
  The rule applies to statements, session requests and prepared statements alike, as 2.2.0's
  transaction rule does.

### Changed

- `getSession()` documents that a server before Chargewire 2.2.1 can answer a statement without rows
  on the streamed path before recording its effect, so a read right after a `USE` or `BEGIN` run
  that way can be stale. The client itself never decides anything from such a read: its rules for
  lost sessions read the SQL it sent.

## [2.2.0] - 2026-11-05

### Added

- A server that is starting again after a stop (`server_resuming`: 503 with `Retry-After`) no
  longer fails the request: the client waits the `Retry-After` (3 s when absent, 1 s to 60 s) and
  sends the same request again, the login and commits included, until the server answers
  something else or the new `resumeTimeout` option (seconds, default `600`; `0` turns the retries
  off) has passed since the first such answer. Then the error is the server's `server_resuming`
  (`ErrorCode.serverResuming`), with its message. These repeats do not count against
  `maxAttempts`; other 503 answers, `server_draining` among them, keep the usual retries.
- `onResuming`, a `connect` option called each time a request gets `server_resuming`, before the
  wait, with `{ attempt, retryAfterMs, elapsedMs, resumeTimeoutMs, detail }` (exported as
  `ResumingEvent`), so an application can show that the server is resuming instead of looking
  frozen. An exception it throws is ignored and the retries go on.
- Aborting a call's signal during a wait for a resuming server stops it at once and sends no
  cancel request (the server took nothing), also while the call waits for a token renewal that
  the resuming server holds. Callers share that login, which goes on while any of them still
  waits. `close()`, of a connection or a prepared statement, and the client's own cancels and
  deletes do not wait for a resuming server: a stopped server holds no sessions or statements.
- `SessionDocument.idle_in_transaction_timeout_s` (§5.1, §5.7), `DiscoveryDocument.links` (§3.3)
  and `Capability.openapi` (§3.1), from the spec. A unit test checks the client's reason, state
  and capability lists against the spec's tables, at compile time where the types are open.

### Fixed

- The exported `SessionEndedReason` type lists `idle_in_transaction` (spec §5.6), so code can
  narrow on it: Hardcharger 2.7.0 (Chargewire 2.1.0) ends a session with it when its transaction
  sat idle past the server's limit, and Chargewire 2.1.1 also when a session evicted as idle held
  a transaction open. The type took any string before, so nothing failed to compile. Each reason
  now carries its meaning from the spec in a doc comment.
- A request that finds its session lost runs again on the replacement only when the client knows
  no transaction was open in the lost session (spec §5.7, Chargewire 2.1.1;
  [gizmodata/hardcharger#29](https://github.com/gizmodata/hardcharger/issues/29)). After
  `session_not_found` a statement used to run again in autocommit whenever autocommit was on,
  even after SQL `BEGIN` had opened a transaction that went with the session, so it committed on
  its own while the transaction's earlier statements were gone. It now fails (the replacement is
  open, so the next call works) when SQL that can begin a transaction (`BEGIN`, `START
  TRANSACTION`, anything naming autocommit) ran in the lost session; a session that ran no such
  SQL is still replaced without a failure. A session request (metadata, options, the session
  document) that finds such a loss, or `idle_in_transaction`, or a loss with autocommit off, fails
  the same way instead of running again and hiding it from the statements that follow. A
  prepared statement is prepared again and run under the same condition.
- `connect`'s `signal` now also stops the login and the session's creation (it reached discovery
  only), which matters now that a login can wait minutes for a resuming server.

## [2.1.0] - 2026-11-04

### Changed

- A session the server ended because its transaction sat idle past the server's
  idle-in-transaction timeout (`session_ended`, reason `idle_in_transaction`, Chargewire 2.1.0;
  Hardcharger 2.7.0's `idle_in_transaction_session_timeout`) is replaced by a new session, the way
  a session the server no longer knows is, without renewing the token. The statement that found
  it ended fails with that error and is never run again on the new session, whether the
  transaction was begun with autocommit off or with `BEGIN` in SQL: run in autocommit it would
  commit on its own while the transaction's earlier statements had been rolled back. The next
  statement runs on the new session.

### Fixed

- A result with no rows and a LIST column (a query whose filter matched nothing, say) failed in
  the reader with "Cannot read properties of undefined (reading 'byteLength')": apache-arrow
  makes one empty batch of a stream that has a schema and no record batches, and that batch's
  LIST columns have no child data, which the buffering limit's byte count walked into. The
  count now skips what isn't there and reads such a batch as 0 bytes
  ([gizmodata/hardcharger#23](https://github.com/gizmodata/hardcharger/issues/23)). So does the
  empty batch of an ingest of an empty table, or of a prepared statement with no parameter rows,
  whose data has no children at all.

## [2.0.1] - 2026-10-29

### Fixed

- The README's status line still described 1.0.0 and Hardcharger 2.0.0. It now names no version,
  and points at the latest release and this changelog instead.

## [2.0.0] - 2026-10-29

The client for the protocol under its new name, Chargewire: `@gizmodata/chargewire` on npm. It works
with servers on either side of the rename.

### Changed

- The client speaks the protocol under its new name, Chargewire: the package is
  `@gizmodata/chargewire`, the error class `ChargewireError`, the URL scheme `chargewire://`
  (default base path `/chargewire`) and the protocol headers `Chargewire-*`. Connection strings
  saved before the rename keep working unchanged: their scheme and default base path are read as
  the current ones, with nothing logged.
- The client also works with servers from before the rename, such as Hardcharger 2.0.x. When
  nothing answers at the default base path (404), it looks for a pre-rename server at that
  server's own base path and, if it finds one, speaks its spelling (paths, headers, error types,
  column-default metadata, the browser sign-in fragment) for the rest of the connection. It
  discovers once per connection, never falls back for a custom base path, logs nothing about it,
  and a current server is never asked at the old path.

### Fixed

- A query finishing during connection close no longer sends a late statement-delete request
  against the ended session. Session close releases those statements, avoiding spurious 404
  errors during browser sign-out while preserving cleanup already in progress.

## [1.0.0] - 2026-10-20

The first release, for Chargewire protocol 1.0.0. Earlier builds (0.1.0) were never published;
the Changed and Fixed entries describe what moved since them, for anyone who installed one from git.
<!-- Set the date above at tag time. -->

### Added

- Release automation uses separate concurrency groups for the publishing workflow and
  its reusable test workflow, so a tag cannot deadlock while waiting for its own tests.
- `@gizmodata/chargewire`: a TypeScript client for the Chargewire protocol over plain
  `fetch` and Apache Arrow, for Node 22.19+, browsers, Deno, Bun and Cloudflare Workers. ESM and
  CJS builds with types; a `node` build (TLS options through undici, streamed uploads, 8
  partitions) and a `default` build for browsers and edge runtimes (4 partitions), chosen by
  export conditions. `apache-arrow` 21 is a peer dependency.
- `connect` with a password, an access token, a token provider or an identity provider's token
  (`token_exchange`); `chargewire://`, `https://` and `http://` URLs, with schemes a wrapper can add.
- `query` (an Arrow Table), `stream` (an async iterator of RecordBatches with backpressure),
  `execute` (rows changed), prepared statements with JSON or Arrow parameters and
  `executeBatch`, bulk `ingest` from Tables, batches or (async) iterables, catalog `metadata`
  including `columns`, transactions, session options and `close`.
- Streams are complete only with Arrow's end-of-stream marker; retained results resume from the
  next batch; partitioned results (§6.10) are read concurrently and merged in order; requests
  carry Idempotency-Keys and are retried safely; tokens are renewed; lost sessions are replaced
  with their options; an `AbortSignal` cancels the statement on the server (by id, through the
  session, or by resending with the Idempotency-Key); zstd result buffers through fzstd.
- Typed `ChargewireError` with the problem document's code, status, SQLSTATE, detail and request id.
- Tests: unit tests with an in-process fake server, live tests against chargewire-duckdb and Hardcharger
  (failing, never skipping, without a server, and when no test reached one), Node/Deno/Bun/workerd
  smoke tests, and Chromium/WebKit tests of the example page. CI against the Hardcharger image;
  a tag-triggered release gated on the full suite, published with npm trusted publishing.
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
  later, the browser build's credentials mode), live tests on chargewire-duckdb and Hardcharger
  (`test/live/mtls.test.ts`: sign-in with a split result and an upload, an unknown identity, a bound
  token over another certificate and its twin, a grant without a certificate, identity match, a
  server with certificate sign-in off), and `npm run test:browser:mtls`, Chromium and WebKit signing
  in from a page on another origin, which fails on servers that don't send
  `Access-Control-Allow-Credentials`.
- Chargewire protocol 1.0.0 (chargewire spec 1.0.0): the client follows the stable version 1.
- `ErrorCode.partitionNotFound` (`partition_not_found`, §6.4), `ErrorCode.internalError`
  (`internal_error`, 500) and `ErrorCode.clientHttpError` (`client_http_error`, an error answer
  without a problem document, such as a proxy's page; `status` says what it was). `ErrorCode` now
  lists every server code of version 1, and a unit test keeps it so.
- `Capability.resultLocations` (`result_locations`). On a server that lists `result_locations` the
  client sends `Chargewire-Result-Locations: remote` and reads partitions from their locations; it never
  sends the header otherwise, and a partition with a location it did not ask for is a
  `client_protocol_error`.
- Types `InvalidTokenReason`, `CancelReason` and `ServerInfo` (the frozen version 1 keys of
  `GET …/metadata/server-info`: `server_name`, `server_version`, `server_arrow_version`,
  `server_read_only`, `sql_identifier_quote_char`, `sql_transactions_supported`; a missing key is
  unknown). `conn.metadata.serverInfo()` returns `ServerInfo`. `SessionEndedReason` gains
  `token_revoked`.
- `version`, the package's version. In Node, Deno and Bun every request sends
  `User-Agent: chargewire-js/<version>` unless `userAgent` says otherwise (browsers set their own).
- A TLS alert `certificate_required` or `certificate_revoked` from the server's handshake is
  reported with that code (§4.4), not as a transport error.
- Tests: unit tests for each 1.0 behaviour (invalid_token and session_ended reasons, unknown
  states, transaction values, cancel reasons, result kinds and capabilities, the 409/422 submit
  errors, split results without an order, remote partitions read at once and only when asked for,
  the query tag's escaping and size, client code names, User-Agent); live tests that a runtime
  failure is `execution_error` with status 422 on both submit paths, that server-info has the
  frozen keys with their types and none of the removed ones, and that a non-ASCII query tag is
  accepted.
- Browser sign-in (chargewire spec §4.3, capability `oauth_browser`): `connect({ authType:
  "oauth_browser", openUrl })` signs in with the server's identity provider through a browser and
  refuses a server without the capability before creating a flow; `browserSignIn` does it
  without a connection; `startBrowserSignIn` (optional `returnTo`), `pollBrowserSignIn` (the
  poll secret in the JSON body, never a URL or header; a failed flow throws its code) and
  `takeBrowserSignInFlowId` are the steps; `beginBrowserRedirectSignIn` and
  `completeBrowserRedirectSignIn` serve web pages that come back to themselves (the secret in
  this tab's `sessionStorage`, the flow id read from and removed from the fragment, flows the tab
  did not start ignored); `browserSignInProvider(discovery)` gives the provider's name. New error
  codes `flow_not_found`, `invalid_return_to`, `access_denied`, `identity_provider_error`. Unit
  tests (13) and live tests (4) against `chargewire-duckdb` with a mock OpenID Connect provider
  (`test/live/idp.ts`; server flags in `CHARGEWIRE_JS_TEST_SERVER_OAUTH_ARGS`).
- `conn.transactionState()` and `SessionDocument.transaction` (chargewire spec §5.2): `none`,
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
  are 409 with `cancel_reason`) carries `statementId` (from `Chargewire-Statement-Id`) and
  `cancelReason`, and the statement is deleted on the server as any finished one is.
- A split result's partitions, on this server or others, are all opened at once (§6.10). Partitions
  on other servers used to be read one after another, and partition 0 was opened before the rest.
- `Chargewire-Query-Tag` is sent as ASCII JSON, every other character as a `\u` escape (§2.5), and a
  tag over 4,096 bytes is refused (`client_invalid_argument`) before anything is sent.
- `ipcCompression` takes `"none"`, `"lz4_frame"`, `"zstd"` or `"auto"`, and a codec is used only
  when the server lists its capability (`ipc_compression_lz4_frame`, `ipc_compression_zstd`). The
  chosen codec is sent in `Chargewire-IPC-Compression` on every request that returns Arrow: the submit,
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
- A streamed result split into several partitions without `Chargewire-Result-Order` (or with an unknown
  one) was read as `any`; it is a `client_protocol_error` (§6.10). So is a statement document with
  several partitions and no (or an unknown) `partition_order`, which was read partition after
  partition.
- An explicit port 443 was dropped from a plain-HTTP URL: `chargewire://host:443?tls=false` and
  `http://host:443` dialled port 80, and a wrapper's scheme with a default port of its own
  (`hardcharger://host:443`) dialled that default instead of 443. The URL is parsed as https,
  which drops 443 as its default; the port is now taken from the URL's text.
- A Number beyond `Number.MAX_SAFE_INTEGER` in JSON parameters (or any JSON body) is written in
  exponent form, so the server reads exactly that double. `JSON.stringify` wrote `2 ** 63` as
  `9223372036854776000`, another integer, which a server that binds wide integers exactly (spec
  §6.1, chargewire fc0c683) bound as that integer. Bigints were and are written as exact integers of
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

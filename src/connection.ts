// Licensed under the Apache License, Version 2.0.

import type { Schema, Table } from "apache-arrow";

import { type IpcCompression, ipcCompressions } from "./compression.js";
import { Core, type StatementSettings } from "./core.js";
import { ErrorCode, WarpSqlError, invalidArgument, protocolError } from "./errors.js";
import {
  type Credentials,
  HttpClient,
  type Logger,
  type RequestBody,
  decodeJSON,
  jsonBody,
  newIdempotencyKey,
  stringifyJSON,
} from "./http.js";
import { type ArrowInput, arrowBody, decodeSchema } from "./ipc.js";
import { Metadata } from "./metadata.js";
import { browserSignIn } from "./oauth.js";
import { type Parameters, checkJsonParameters, isArrowParameters, parameterRows } from "./params.js";
import { platform } from "#platform";
import type { TlsOptions } from "./platform/types.js";
import {
  Capability,
  type DiscoveryDocument,
  type PreparedDocument,
  type SessionDocument,
  type TransactionState,
} from "./protocol.js";
import { Session, sessionPath } from "./session.js";
import { Execution, type PreparedRef, maxResultPartitions, runRows, runUpdate } from "./statement.js";
import { ResultStream } from "./stream.js";
import { type SchemeMap, defaultSchemes, parseUrl } from "./url.js";
import { version } from "./version.js";

/** How a statement runs. Set on `connect` as defaults, or per call. */
export interface StatementOptions {
  /**
   * Submit, long-poll, then fetch a retained result (§6.1, §6.3), instead of streaming the
   * result in the submit's answer. No request stays open for a whole query, and a broken
   * download resumes: use it behind proxies that cut long requests. Default false.
   */
  async?: boolean;
  /** `true` asks the server to keep results so a dropped download resumes (§6.5); `false` asks it not to. Default: the server's choice. */
  retainResult?: boolean;
  /** Milliseconds before the server cancels the statement (§6.9). */
  statementTimeoutMs?: number;
  /**
   * A JSON object the server may record with the statement, for observability
   * (`Warp-Query-Tag`, §2.5). Sent as ASCII JSON (other characters as `\u` escapes), at
   * most 4,096 bytes; a larger tag is refused before anything is sent.
   */
  queryTag?: Record<string, unknown>;
  /**
   * Arrow buffer compression for results (§8.2), used only when the server lists the
   * codec's capability: `lz4_frame` (cheap to decode, for fast links), `zstd` (smaller,
   * for slow links), or `auto`: lz4_frame when the discovery request's round trip is under
   * 10 ms, else zstd. Default `none`: decoding runs on the thread that reads the result,
   * which in a browser is usually the main thread.
   */
  ipcCompression?: IpcCompression;
  /**
   * Read up to this many partitions of a result at once, each over its own connection
   * (§6.10); 1 reads one stream. Default 8 in Node, Deno and Bun, 4 in browsers and edge
   * runtimes (which allow about six connections per host over HTTP/1.1).
   */
  resultPartitions?: number;
  /** `any` lets a result read in partitions come back in any row order. Default `preserve`. */
  resultOrder?: "preserve" | "any";
}

export interface CallOptions extends StatementOptions {
  /** Cancels the statement, on the server too, when it fires. */
  signal?: AbortSignal;
}

export interface ConnectOptions extends StatementOptions {
  /** `warp://host:port[/base][?tls=false]`, `https://host:port[/base]` or `http://host:port[/base]`. */
  url: string;
  /** With `password`: the password grant (§4.1). */
  username?: string;
  password?: string;
  /** A Warp SQL access token obtained elsewhere; used as is, never renewed. */
  token?: string;
  /** Returns a fresh Warp SQL access token; called at connect and whenever the server refuses the current one. */
  tokenProvider?: () => string | Promise<string>;
  /** An identity provider's token (e.g. an OIDC ID token) for the `token_exchange` grant; a function is called for each new token. */
  subjectToken?: string | (() => string | Promise<string>);
  /**
   * `"client_certificate"`: sign in with the TLS client certificate alone, no password
   * (§4.4; servers with capability `mtls_identity`). In Node, Deno and Bun the certificate
   * is `tls.cert` and `tls.key`; in a browser it is the one the user picks, and requests
   * are sent with `credentials: "include"` (see `fetchCredentials`). The token the server
   * issues is bound to the certificate and renewed with it. Takes no username, password or
   * token. Default: `"password"` (or whichever credential is given).
   *
   * `"oauth_browser"`: browser sign-in with the server's identity provider (§4.3; servers
   * with capability `oauth_browser`). `openUrl` is given the sign-in URL to open in a
   * browser (or show); the connection waits up to `browserSignInTimeoutMs` for the person
   * to sign in, then holds the server's own access token. When that token nears its
   * expiry, the next request runs a new browser sign-in (`openUrl` again). Takes no
   * username, password or token. In a web page that should come back to itself instead,
   * use `beginBrowserRedirectSignIn` and `completeBrowserRedirectSignIn`, then `token`.
   */
  authType?: "password" | "client_certificate" | "oauth_browser";
  /** With `authType: "oauth_browser"`: opens (or shows) the identity provider's sign-in URL. */
  openUrl?: (url: string) => void | Promise<void>;
  /** With `authType: "oauth_browser"`: how long to wait for the person to sign in. Default 5 minutes. */
  browserSignInTimeoutMs?: number;
  /**
   * fetch's credentials mode for every request. Browsers present a client certificate on
   * a cross-origin request only with `"include"` (and then need the server to allow
   * credentials for the page's origin). Default: `"include"` in a browser with
   * `authType: "client_certificate"`, otherwise the runtime's default.
   */
  fetchCredentials?: RequestCredentials;
  /** The session's current catalog and schema (§5.3). */
  catalog?: string;
  schema?: string;
  /** More session options (§5.3), e.g. `{ session_tag: {...} }`. */
  sessionOptions?: Record<string, unknown>;
  /** TLS settings (Node, Deno, Bun): CA, client certificate, server name, skip verification. */
  tls?: TlsOptions;
  /** The fetch to use (default: the global one). */
  fetch?: typeof fetch;
  /** Sends of a request that is safe to repeat, first included. Default 4. */
  maxAttempts?: number;
  /** Replace a session the server lost (§5.6). Default true. */
  reconnect?: boolean;
  /**
   * Bytes of an unread streamed result kept in memory when another request needs the
   * connection's session. Default 128 MiB.
   */
  resultBufferBytes?: number;
  /** Diagnostics; `warn` defaults to console.warn (session replacements are reported there). */
  logger?: Logger;
  /** The User-Agent header (Node, Deno, Bun; browsers set their own). Default `warp-sql-js/<version>` there. */
  userAgent?: string;
  /** URL schemes accepted, for wrappers that add their own (see `defaultSchemes`). */
  schemes?: SchemeMap;
  /** Abandons connecting when it fires. */
  signal?: AbortSignal;
}

const defaultResultBufferBytes = 128 << 20;
const ingestModes = ["create", "append", "replace", "create_append"] as const;

/** Bulk ingest options (§8.1). */
export interface IngestOptions {
  /** `create` (fail if it exists), `append` (fail if it doesn't), `replace`, or `create_append` (default). */
  mode?: (typeof ingestModes)[number];
  catalog?: string;
  schema?: string;
  /** Create a temporary table. */
  temporary?: boolean;
  signal?: AbortSignal;
}

/**
 * Opens a connection: discovers the server (§3.1), signs in (§4), and opens a session (§5).
 *
 * ```ts
 * const conn = await connect({ url: "warp://db.example.com:31337", username: "joe", password });
 * ```
 */
export async function connect(options: ConnectOptions): Promise<Connection> {
  if (options === null || typeof options !== "object") throw invalidArgument("connect takes an options object");
  const base = parseUrl(options.url, options.schemes ?? defaultSchemes);
  const credentials = credentialsFrom(options);
  if (options.tls !== undefined && options.fetch !== undefined) {
    throw invalidArgument("pass either tls or fetch: tls settings cannot be applied to a fetch of your own");
  }
  if (options.tls !== undefined && (options.tls.cert === undefined) !== (options.tls.key === undefined)) {
    throw invalidArgument("tls.cert and tls.key go together: a client certificate needs its private key");
  }
  if (credentials.kind === "certificate") {
    if (base.protocol !== "https:") {
      throw invalidArgument(`authType "client_certificate" needs TLS, but ${base.href} is plain HTTP`);
    }
    if (platform.name === "node" && options.fetch === undefined && options.tls?.cert === undefined) {
      throw invalidArgument('authType "client_certificate" needs a client certificate: set tls.cert and tls.key');
    }
  }
  const fetchFn =
    options.fetch ??
    (options.tls !== undefined
      ? await platform.tlsFetch(options.tls)
      : globalThis.fetch.bind<typeof fetch>(globalThis));
  if (credentials.kind === "browser") {
    // Each sign-in goes through the connection's own fetch (its TLS settings included).
    const openUrl = options.openUrl!;
    const timeoutMs = options.browserSignInTimeoutMs;
    credentials.signIn = () =>
      browserSignIn({
        url: options.url,
        ...(options.schemes !== undefined ? { schemes: options.schemes } : {}),
        fetch: fetchFn,
        ...(options.fetchCredentials !== undefined ? { fetchCredentials: options.fetchCredentials } : {}),
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        openUrl,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
  }
  const logger: Logger = {
    debug: options.logger?.debug?.bind(options.logger),
    warn: options.logger
      ? options.logger.warn?.bind(options.logger)
      : (message, fields) => console.warn(`[warp-sql] ${message}`, fields ?? ""),
  };
  const http = new HttpClient({
    base,
    fetch: fetchFn,
    credentials,
    maxAttempts: options.maxAttempts ?? 4,
    userAgent: options.userAgent ?? (platform.name === "node" ? `warp-sql-js/${version}` : undefined),
    logger,
    fetchCredentials:
      options.fetchCredentials ??
      (credentials.kind === "certificate" && platform.name === "web" ? "include" : undefined),
  });
  const settings = resolveSettings(defaultsFrom(options), options);
  const resultBufferBytes = options.resultBufferBytes ?? defaultResultBufferBytes;
  if (!Number.isFinite(resultBufferBytes) || resultBufferBytes < 0)
    throw invalidArgument("resultBufferBytes must be a number of bytes");

  const { discovery, rttMs: discoveryRttMs } = await discover(http, options.signal);
  const grant =
    credentials.kind === "password"
      ? "password"
      : credentials.kind === "subject"
        ? "token_exchange"
        : credentials.kind === "certificate"
          ? "client_certificate"
          : undefined;
  const grants = discovery.auth?.grant_types;
  if (
    credentials.kind === "certificate" &&
    !(discovery.capabilities?.includes(Capability.mtlsIdentity) === true && grants?.includes(grant!) === true)
  ) {
    throw new WarpSqlError({
      code: ErrorCode.notImplemented,
      message:
        `the server does not offer client certificate sign-in (capability ${Capability.mtlsIdentity}, ` +
        `grant client_certificate): it needs TLS with client CAs and certificate sign-in turned on ` +
        `(it offers ${Array.isArray(grants) ? grants.join(", ") || "none" : "no grant list"})`,
    });
  }
  if (credentials.kind === "browser" && discovery.capabilities?.includes(Capability.oauthBrowser) !== true) {
    throw new WarpSqlError({
      code: ErrorCode.notImplemented,
      message: `the server does not offer browser sign-in (capability ${Capability.oauthBrowser})`,
    });
  }
  if (grant !== undefined && Array.isArray(grants) && !grants.includes(grant)) {
    throw new WarpSqlError({
      code: ErrorCode.notImplemented,
      message: `the server does not accept the ${grant} grant (it offers ${grants.join(", ") || "none"})`,
    });
  }
  await http.authenticate();

  const sessionOptions: Record<string, unknown> = { ...options.sessionOptions };
  if (options.catalog !== undefined) sessionOptions["catalog"] = options.catalog;
  if (options.schema !== undefined) sessionOptions["schema"] = options.schema;
  const session = await Session.open(http, sessionOptions, options.reconnect ?? true);
  const core = new Core({ http, session, discovery, platform, settings, resultBufferBytes, discoveryRttMs });
  await core.resolveCodec(settings);
  return new Connection(core);
}

function credentialsFrom(options: ConnectOptions): Credentials {
  if (
    options.authType !== undefined &&
    options.authType !== "password" &&
    options.authType !== "client_certificate" &&
    options.authType !== "oauth_browser"
  ) {
    throw invalidArgument(
      `authType must be "password", "client_certificate" or "oauth_browser", not ${JSON.stringify(options.authType)}`,
    );
  }
  if (
    options.authType !== "oauth_browser" &&
    (options.openUrl !== undefined || options.browserSignInTimeoutMs !== undefined)
  ) {
    throw invalidArgument('openUrl and browserSignInTimeoutMs go with authType "oauth_browser"');
  }
  if (options.authType === "oauth_browser") {
    const extra = (["username", "password", "token", "tokenProvider", "subjectToken"] as const).filter(
      (name) => options[name] !== undefined,
    );
    if (extra.length > 0) {
      throw invalidArgument(
        `authType "oauth_browser" signs in through the browser; do not also pass ${extra.join(", ")}`,
      );
    }
    if (typeof options.openUrl !== "function") {
      throw invalidArgument('authType "oauth_browser" needs openUrl, a function that opens (or shows) the sign-in URL');
    }
    const timeout = options.browserSignInTimeoutMs;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      throw invalidArgument("browserSignInTimeoutMs must be a positive number of milliseconds");
    }
    // Filled in by connect, which has the fetch.
    return { kind: "browser", signIn: () => Promise.reject(new Error("browser sign-in not set up")) };
  }
  if (options.authType === "client_certificate") {
    const extra = (["username", "password", "token", "tokenProvider", "subjectToken"] as const).filter(
      (name) => options[name] !== undefined,
    );
    if (extra.length > 0) {
      throw invalidArgument(
        `authType "client_certificate" signs in with the client certificate alone; do not also pass ${extra.join(", ")}`,
      );
    }
    return { kind: "certificate" };
  }
  const given = [
    options.password !== undefined ? "password" : undefined,
    options.token !== undefined ? "token" : undefined,
    options.tokenProvider !== undefined ? "tokenProvider" : undefined,
    options.subjectToken !== undefined ? "subjectToken" : undefined,
  ].filter((x) => x !== undefined);
  if (given.length !== 1) {
    throw invalidArgument(
      given.length === 0
        ? 'credentials are required: username and password, token, tokenProvider, subjectToken, or authType "client_certificate"'
        : `pass one kind of credential, not ${given.join(" and ")}`,
    );
  }
  if (options.password !== undefined) {
    if (typeof options.username !== "string" || options.username === "")
      throw invalidArgument("a password needs a username");
    return { kind: "password", username: options.username, password: options.password };
  }
  if (options.username !== undefined) throw invalidArgument("a username goes with a password");
  if (options.token !== undefined) {
    if (typeof options.token !== "string" || options.token === "")
      throw invalidArgument("token must be a non-empty string");
    return { kind: "static", token: options.token };
  }
  if (options.tokenProvider !== undefined) {
    const provider = options.tokenProvider;
    return { kind: "provider", provider: async () => provider() };
  }
  const subject = options.subjectToken!;
  return { kind: "subject", subjectToken: async () => (typeof subject === "function" ? subject() : subject) };
}

/** Reads the discovery document, timing it to its response headers: about a round trip (see Core.linkRttMs). */
async function discover(
  http: HttpClient,
  signal: AbortSignal | undefined,
): Promise<{ discovery: DiscoveryDocument; rttMs: number }> {
  let doc: DiscoveryDocument;
  let rttMs: number;
  try {
    const req = { method: "GET", path: "", idempotent: true, anonymous: true, signal } as const;
    const start = performance.now();
    const resp = await http.request(req);
    rttMs = performance.now() - start;
    doc = await decodeJSON<DiscoveryDocument>(resp, req);
  } catch (err) {
    if (WarpSqlError.is(err, ErrorCode.clientProtocolError, ErrorCode.clientHttpError, ErrorCode.notFound)) {
      throw protocolError(`${http.base.href} does not describe a Warp SQL server: ${(err as Error).message}`, err);
    }
    throw err;
  }
  if (doc === null || typeof doc !== "object" || doc.protocol !== "warp-sql") {
    throw protocolError(
      `${http.base.href} does not describe a Warp SQL server (protocol ${JSON.stringify(doc?.protocol)})`,
    );
  }
  if (!Array.isArray(doc.protocol_versions) || !doc.protocol_versions.includes("1")) {
    throw protocolError(
      `the server at ${http.base.href} does not speak Warp SQL version 1 (it offers ${JSON.stringify(doc.protocol_versions)})`,
    );
  }
  return { discovery: doc, rttMs };
}

function defaultsFrom(options: ConnectOptions): StatementSettings {
  return {
    async: false,
    retainResult: undefined,
    statementTimeoutMs: undefined,
    queryTag: undefined,
    ipcCompression: "none",
    ipcCodec: undefined,
    resultPartitions: options.resultPartitions ?? platform.defaultResultPartitions,
    resultOrder: "preserve",
  };
}

/** Merges per-call options over the defaults, refusing bad values before anything is sent. */
function resolveSettings(defaults: StatementSettings, options: StatementOptions): StatementSettings {
  const s = { ...defaults };
  if (options.async !== undefined) s.async = options.async;
  if (options.retainResult !== undefined) s.retainResult = options.retainResult;
  if (options.statementTimeoutMs !== undefined) {
    if (!Number.isFinite(options.statementTimeoutMs) || options.statementTimeoutMs < 0) {
      throw invalidArgument("statementTimeoutMs must be a non-negative number of milliseconds");
    }
    s.statementTimeoutMs = options.statementTimeoutMs;
  }
  if (options.queryTag !== undefined) s.queryTag = queryTagHeader(options.queryTag);
  if (options.ipcCompression !== undefined) {
    if (!ipcCompressions.includes(options.ipcCompression)) {
      throw invalidArgument(
        `ipcCompression must be ${ipcCompressions.map((c) => `"${c}"`).join(", ")}, not ${JSON.stringify(options.ipcCompression)}`,
      );
    }
    s.ipcCompression = options.ipcCompression;
  }
  if (options.resultPartitions !== undefined) {
    const n = options.resultPartitions;
    if (!Number.isInteger(n) || n < 1 || n > maxResultPartitions) {
      throw invalidArgument(`resultPartitions must be a whole number from 1 to ${maxResultPartitions}, not ${n}`);
    }
    s.resultPartitions = n;
  }
  if (options.resultOrder !== undefined) {
    if (options.resultOrder !== "preserve" && options.resultOrder !== "any") {
      throw invalidArgument(`resultOrder must be "preserve" or "any", not ${JSON.stringify(options.resultOrder)}`);
    }
    s.resultOrder = options.resultOrder;
  }
  return s;
}

/**
 * A connection to a Warp SQL server: one session (§5), with its options, its open
 * transaction and its temporary tables. Safe to share between concurrent calls; the
 * server runs a session's statements one at a time.
 */
export class Connection {
  readonly #core: Core;
  /** Catalog metadata (§10). */
  readonly metadata: Metadata;

  /** @internal Use `connect`. */
  constructor(core: Core) {
    this.#core = core;
    this.metadata = new Metadata(core);
  }

  /** The current session's id. It changes when a lost session is replaced. */
  get sessionId(): string {
    return this.#core.session.id;
  }

  /** How many times the server lost the session and the client replaced it. */
  get sessionReplacements(): number {
    return this.#core.session.replacements;
  }

  /** The server's discovery document (§3.1). */
  get server(): DiscoveryDocument {
    return this.#core.discovery;
  }

  /** The optional features the server offers (§3.1). */
  get capabilities(): ReadonlySet<string> {
    return this.#core.capabilities;
  }

  get closed(): boolean {
    return this.#core.closed;
  }

  async #settings(options: StatementOptions): Promise<StatementSettings> {
    const s = resolveSettings(this.#core.settings, options);
    await this.#core.resolveCodec(s);
    return s;
  }

  async #before(): Promise<void> {
    this.#core.checkOpen();
    await this.#core.settle();
  }

  /**
   * Runs a query and returns its rows as an Arrow Table. A statement without rows
   * returns an empty table.
   *
   * ```ts
   * const table = await conn.query("SELECT * FROM sales WHERE year = ?", [2026]);
   * ```
   */
  async query(sql: string, params?: Parameters, options: CallOptions = {}): Promise<Table> {
    return this.#open(sql, params, options, false).toTable();
  }

  /**
   * Runs a query and streams its rows as Arrow record batches.
   *
   * ```ts
   * for await (const batch of conn.stream("SELECT * FROM big_table")) { … }
   * ```
   */
  stream(sql: string, params?: Parameters, options: CallOptions = {}): ResultStream {
    return this.#open(sql, params, options, true);
  }

  #open(sql: string, params: Parameters | undefined, options: CallOptions, register: boolean): ResultStream {
    const core = this.#core;
    let stream: ResultStream | undefined = undefined;
    let prepared: PreparedStatement | undefined;
    const opening = (async () => {
      checkSql(sql);
      core.checkOpen();
      await core.settle(stream);
      const settings = await this.#settings(options);
      if (isArrowParameters(params)) {
        prepared = await PreparedStatement.create(core, sql, options.signal);
        return prepared.runRows(params, settings, options.signal);
      }
      const body = submitBody(sql, params);
      return runRows(new Execution(core, settings, body, undefined, options.signal));
    })();
    stream = new ResultStream(core, opening, {
      register,
      onEnd: () => {
        if (prepared !== undefined) void prepared.close();
      },
    });
    return stream;
  }

  /**
   * Runs a statement without reading rows and returns the rows it changed: a number, or
   * null when the engine does not count (DDL, SET, …, or a query).
   *
   * ```ts
   * const changed = await conn.execute("DELETE FROM t WHERE id = ?", [42]);
   * ```
   */
  async execute(sql: string, params?: Parameters, options: CallOptions = {}): Promise<number | null> {
    checkSql(sql);
    await this.#before();
    const settings = await this.#settings(options);
    if (isArrowParameters(params)) {
      const prepared = await PreparedStatement.create(this.#core, sql, options.signal);
      try {
        return await prepared.runUpdate(params, settings, options.signal);
      } finally {
        void prepared.close();
      }
    }
    return runUpdate(new Execution(this.#core, settings, submitBody(sql, params), undefined, options.signal));
  }

  /** Prepares a statement on the server (§7). */
  async prepare(sql: string, options: { signal?: AbortSignal } = {}): Promise<PreparedStatement> {
    checkSql(sql);
    await this.#before();
    return PreparedStatement.create(this.#core, sql, options.signal);
  }

  /**
   * Bulk-loads Arrow data into a table (§8) and returns the rows written. The upload is
   * one transaction where the engine supports it.
   *
   * ```ts
   * await conn.ingest("events", table, { mode: "append" });
   * ```
   */
  async ingest(tableName: string, data: ArrowInput, options: IngestOptions = {}): Promise<number> {
    const core = this.#core;
    if (typeof tableName !== "string" || tableName === "") throw invalidArgument("ingest needs a table name");
    const mode = options.mode ?? "create_append";
    if (!ingestModes.includes(mode)) {
      throw invalidArgument(`ingest mode must be one of ${ingestModes.join(", ")}, not ${JSON.stringify(mode)}`);
    }
    await this.#before();
    core.require(Capability.ingest, "bulk ingest");
    // Partitioned ingest (spec §8.3) is not implemented here yet. It would slot in here, as
    // the Go and JDBC drivers do it: on a server listing `partitioned_ingest`, an upload of
    // two batches or more opens an ingest (POST …/ingests), sends its batches as part
    // uploads at once (each with its own Idempotency-Key), and commits with
    // `{"part_count": n}`; any failed part aborts the ingest (DELETE), so nothing is
    // written. Until then, every upload is the single request below (§8.1).
    const body = await arrowBody(data, { streaming: core.platform.streamingUploads });
    const query = {
      table: tableName,
      mode,
      catalog: options.catalog,
      schema: options.schema,
      temporary: options.temporary ? "true" : undefined,
    };
    const headers = { "Idempotency-Key": newIdempotencyKey() };
    const resp = await core.session.do("statement", "", (id) => ({
      method: "POST",
      path: `${sessionPath(id)}/ingest`,
      query,
      headers,
      body,
      idempotent: true,
      signal: options.signal,
    }));
    const answer = await decodeJSON<{ rows_ingested?: unknown }>(resp);
    if (typeof answer.rows_ingested !== "number") throw protocolError("the ingest answer has no rows_ingested");
    return answer.rows_ingested;
  }

  /** Sets session options (§5.3); the client replays them on a replacement session. */
  async setOptions(
    sessionOptions: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    await this.#before();
    return this.#core.session.setOptions(sessionOptions, options.signal);
  }

  /**
   * The session document (§5.2), with the session's current options (a `USE` shows here) and its
   * transaction (a SQL `BEGIN` shows here too, once the statement has ended).
   */
  async getSession(options: { signal?: AbortSignal } = {}): Promise<SessionDocument> {
    await this.#before();
    return this.#core.session.get(options.signal);
  }

  /**
   * Where the session's transaction stands (§5.2): `none`, `open`, or `aborted` (a statement failed
   * or was cancelled inside it; only a rollback ends it). Read from the server, so it follows SQL
   * `BEGIN`/`COMMIT` and what the engine does after an error, not only `setAutocommit`.
   */
  async transactionState(options: { signal?: AbortSignal } = {}): Promise<TransactionState> {
    return (await this.getSession(options)).transaction;
  }

  /** Turns autocommit off (a transaction starts, §5.5) or back on. */
  async setAutocommit(autocommit: boolean, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!autocommit) this.#core.require(Capability.transactions, "transactions");
    await this.setOptions({ autocommit }, options);
  }

  /** Commits the current transaction; the next statement starts a new one. Never retried. */
  async commit(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.#core.require(Capability.transactions, "transactions");
    await this.#before();
    await this.#core.session.commit(options.signal);
  }

  async rollback(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.#core.require(Capability.transactions, "transactions");
    await this.#before();
    await this.#core.session.rollback(options.signal);
  }

  /**
   * Runs `work` in a transaction: commits when it resolves, rolls back when it throws, and
   * turns autocommit back on either way.
   */
  async transaction<T>(work: (conn: this) => Promise<T>): Promise<T> {
    await this.setAutocommit(false);
    try {
      const result = await work(this);
      await this.commit();
      return result;
    } catch (err) {
      await this.rollback().catch(() => {});
      throw err;
    } finally {
      if (!this.closed) await this.setAutocommit(true).catch(() => {});
    }
  }

  /** Ends the session (§5.4): its running statements are cancelled and its results freed. */
  async close(): Promise<void> {
    const core = this.#core;
    if (core.closed) return;
    core.closed = true;
    const streams = [...core.openStreams] as ResultStream[];
    await Promise.all(streams.map((s) => s.close().catch(() => {})));
    // A statement's delete (sent off the caller's path) goes before the session's: sent after
    // it, it would meet a session that is gone, and a browser logs that 404 as an error.
    await Promise.allSettled([...core.pending]);
    await core.session.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** The most bytes a `Warp-Query-Tag` may have (§2.5). */
export const maxQueryTagBytes = 4096;

/**
 * Serializes a query tag for `Warp-Query-Tag` (§2.5): a JSON object, in ASCII (every other
 * character as a `\u` escape, so a header can carry it), at most 4,096 bytes.
 */
export function queryTagHeader(tag: unknown): string {
  if (tag === null || typeof tag !== "object" || Array.isArray(tag)) {
    throw invalidArgument("queryTag must be a JSON object");
  }
  let text: string;
  try {
    text = stringifyJSON(tag);
  } catch (err) {
    throw invalidArgument(`queryTag cannot be written as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  // JSON.stringify leaves non-ASCII characters as they are (and writes lone surrogates as
  // escapes already); every UTF-16 unit above 0x7E becomes \uXXXX, which JSON reads back as
  // the same string. Control characters below 0x20 are escaped by JSON.stringify itself.
  text = text.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  if (text.length > maxQueryTagBytes) {
    throw invalidArgument(
      `queryTag is ${text.length} bytes as JSON, more than the ${maxQueryTagBytes} a server accepts`,
    );
  }
  return text;
}

function checkSql(sql: unknown): void {
  if (typeof sql !== "string" || sql.trim() === "") throw invalidArgument("a SQL string is required");
}

function submitBody(sql: string, params: Parameters | undefined): RequestBody {
  const doc: Record<string, unknown> = { sql };
  if (params !== undefined) doc["parameters"] = checkJsonParameters(params);
  return jsonBody(doc);
}

/**
 * A statement prepared on the server (§7). Executing it binds parameters as JSON values
 * or as Arrow rows, one execution per row. If the server loses the session, the
 * statement is prepared again in the replacement.
 */
export class PreparedStatement {
  readonly #core: Core;
  /** The statement's SQL. */
  readonly sql: string;
  #ref: PreparedRef;
  #doc: PreparedDocument;
  #parameterSchema: Schema | undefined;
  #resultSchema: Schema | undefined;
  #closed = false;

  private constructor(core: Core, sql: string, ref: PreparedRef, doc: PreparedDocument) {
    this.#core = core;
    this.sql = sql;
    this.#ref = ref;
    this.#doc = doc;
    this.#parameterSchema = decodeSchema(doc.parameter_schema);
    this.#resultSchema = decodeSchema(doc.result_schema);
  }

  /** @internal */
  static async create(core: Core, sql: string, signal: AbortSignal | undefined): Promise<PreparedStatement> {
    const { ref, doc } = await prepareOnServer(core, sql, signal);
    return new PreparedStatement(core, sql, ref, doc);
  }

  /** The prepared statement's id on the server. */
  get id(): string {
    return this.#ref.preparedId;
  }

  /** The parameters' Arrow schema, as the server describes them. */
  get parameterSchema(): Schema | undefined {
    return this.#parameterSchema;
  }

  /** The rows' schema, when the server can tell before running (`resultKind` "rows"). */
  get resultSchema(): Schema | undefined {
    return this.#resultSchema;
  }

  /** `rows`, `update`, or null when the server can tell only by running it (§7.1). */
  get resultKind(): "rows" | "update" | null {
    return this.#doc.result_kind ?? null;
  }

  /** Runs it and returns its rows. Each row of Arrow parameters is one execution; their rows concatenate in order. */
  async query(params?: Parameters, options: CallOptions = {}): Promise<Table> {
    return this.#stream(params, options, false).toTable();
  }

  /** Runs it and streams its rows. */
  stream(params?: Parameters, options: CallOptions = {}): ResultStream {
    return this.#stream(params, options, true);
  }

  #stream(params: Parameters | undefined, options: CallOptions, register: boolean): ResultStream {
    let stream: ResultStream | undefined = undefined;
    const opening = (async () => {
      this.#check();
      await this.#core.settle(stream);
      const settings = await this.#settings(options);
      return this.runRows(params, settings, options.signal);
    })();
    stream = new ResultStream(this.#core, opening, { register });
    return stream;
  }

  /** Runs it without reading rows and returns the rows changed (null when not counted). */
  async execute(params?: Parameters, options: CallOptions = {}): Promise<number | null> {
    this.#check();
    await this.#core.settle();
    return this.runUpdate(params, await this.#settings(options), options.signal);
  }

  /**
   * Runs it once per row of plain values, in one request: the values are converted to the
   * server's parameter types (§7.1), so dates, bigints and binary arrive exactly.
   *
   * ```ts
   * await insert.executeBatch([[1, "alice"], [2, "bob"]]);
   * ```
   */
  async executeBatch(rows: readonly (readonly unknown[])[], options: CallOptions = {}): Promise<number | null> {
    return this.execute(parameterRows(this.#parameterSchema, rows), options);
  }

  /** Deletes the prepared statement on the server (§7.3). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const ref = this.#ref;
    try {
      await this.#core.http.void({
        method: "DELETE",
        path: `${sessionPath(ref.sessionId)}/prepared/${encodeURIComponent(ref.preparedId)}`,
        idempotent: true,
      });
    } catch (err) {
      if (
        !WarpSqlError.is(err, ErrorCode.preparedNotFound, ErrorCode.sessionNotFound, ErrorCode.clientConnectionClosed)
      )
        throw err;
    }
  }

  #check(): void {
    if (this.#closed) throw invalidArgument("the prepared statement is closed");
    this.#core.checkOpen();
  }

  async #settings(options: StatementOptions): Promise<StatementSettings> {
    const s = resolveSettings(this.#core.settings, options);
    await this.#core.resolveCodec(s);
    return s;
  }

  async #body(params: Parameters | undefined): Promise<RequestBody> {
    if (isArrowParameters(params)) return arrowBody(params, { streaming: this.#core.platform.streamingUploads });
    return jsonBody(params === undefined ? {} : { parameters: checkJsonParameters(params) });
  }

  /** Prepares it again when its session was replaced. */
  async #current(signal: AbortSignal | undefined): Promise<PreparedRef> {
    if (this.#ref.sessionId !== this.#core.session.id) await this.#reprepare(signal);
    return this.#ref;
  }

  async #reprepare(signal: AbortSignal | undefined): Promise<void> {
    const { ref, doc } = await prepareOnServer(this.#core, this.sql, signal);
    this.#ref = ref;
    this.#doc = doc;
    this.#parameterSchema = decodeSchema(doc.parameter_schema);
    this.#resultSchema = decodeSchema(doc.result_schema);
  }

  /**
   * Runs `run` on a new execution; when the prepared statement is gone (its session was
   * replaced, or the server forgot it), prepares it again and runs once more, if that is
   * safe: outside a transaction and with the body in memory.
   */
  async #withRetry<T>(
    params: Parameters | undefined,
    settings: StatementSettings,
    signal: AbortSignal | undefined,
    run: (exec: Execution) => Promise<T>,
  ): Promise<T> {
    const body = await this.#body(params);
    const ref = await this.#current(signal);
    try {
      return await run(new Execution(this.#core, settings, body, ref, signal));
    } catch (err) {
      const gone =
        WarpSqlError.is(err, ErrorCode.preparedNotFound) ||
        (WarpSqlError.is(err) && err.replacementSessionId !== undefined);
      if (!gone || body.stream !== undefined || this.#core.session.inTransaction || signal?.aborted) throw err;
      await this.#reprepare(signal);
      return run(new Execution(this.#core, settings, body, this.#ref, signal));
    }
  }

  /** @internal */
  runRows(
    params: Parameters | undefined,
    settings: StatementSettings,
    signal: AbortSignal | undefined,
  ): ReturnType<typeof runRows> {
    return this.#withRetry(params, settings, signal, runRows);
  }

  /** @internal */
  runUpdate(
    params: Parameters | undefined,
    settings: StatementSettings,
    signal: AbortSignal | undefined,
  ): Promise<number | null> {
    return this.#withRetry(params, settings, signal, runUpdate);
  }
}

async function prepareOnServer(
  core: Core,
  sql: string,
  signal: AbortSignal | undefined,
): Promise<{ ref: PreparedRef; doc: PreparedDocument }> {
  core.require(Capability.preparedStatements, "prepared statements (and Arrow parameters)");
  let sessionId = core.session.id;
  const resp = await core.session.do("session", "", (id) => {
    sessionId = id;
    return { method: "POST", path: `${sessionPath(id)}/prepared`, body: jsonBody({ sql }), idempotent: true, signal };
  });
  const doc = await decodeJSON<PreparedDocument>(resp);
  if (typeof doc.prepared_id !== "string" || doc.prepared_id === "")
    throw protocolError("the server prepared a statement without an id");
  return { ref: { sessionId, preparedId: doc.prepared_id }, doc };
}

// Licensed under the Apache License, Version 2.0.

import { ErrorCode, ChargewireError, problemError, protocolError } from "./errors.js";
import { type HttpClient, type HttpRequest, decodeJSON, discard, jsonBody } from "./http.js";
import { type OptionsResult, type SessionDocument, transactionState } from "./protocol.js";

/**
 * What a request may do when the server no longer has its session (§5.6). The server
 * never recreates a session, so the client decides.
 *
 * - `session`: acts on the session as a whole (options, metadata, preparing); runs
 *   again on a replacement session, under the same condition: otherwise it would hide the
 *   loss of a transaction, and the next statement would run alone, in autocommit.
 * - `statement`: runs SQL; runs again on a replacement only when the client knows no
 *   transaction was open in the lost session (inside one, the work before it is gone, and
 *   running the rest would commit half a transaction; spec §5.7).
 * - `handle`: names something that lived in the lost session (a statement, a prepared
 *   statement, the open transaction); fails.
 */
export type Scope = "session" | "statement" | "handle";

/** The longest a request that only tidies up (a clean-up, an observation) may take. */
export const tidyTimeoutMs = 10_000;

export function sessionPath(id: string): string {
  return "/v1/sessions/" + encodeURIComponent(id);
}

/**
 * Whether `err` says the session is gone in a way a new session cures (§5.6): the server
 * doesn't have it (`session_not_found`), ended it while it held a transaction open, idle past
 * the server's idle-in-transaction limit or evicted as idle (`idle_in_transaction`: the
 * transaction was rolled back, a new session is as good as the old one was), or ended it because its token expired and the client can get
 * a new token (`canRenew`), which it must before opening a new session. After
 * `credentials_changed`, `principal_dropped` or `token_revoked` the client may not sign in
 * again on its own (§4.2), and an administrator's `killed` (or a reason the client doesn't
 * know) is reported, not papered over: those are the error.
 */
export function isSessionLost(err: unknown, canRenew: boolean): err is ChargewireError {
  return (
    err instanceof ChargewireError &&
    (err.code === ErrorCode.sessionNotFound ||
      (err.code === ErrorCode.sessionEnded &&
        (err.reason === "idle_in_transaction" || (err.reason === "token_expired" && canRenew))))
  );
}

/** Whether `err` says the server ended the session with a transaction open in it (§5.6). */
export function lostTransaction(err: ChargewireError): boolean {
  return err.code === ErrorCode.sessionEnded && err.reason === "idle_in_transaction";
}

/**
 * Whether `sql` may open a transaction that outlives the statement: SQL `BEGIN` or `START
 * TRANSACTION`, or anything about autocommit. A plain word search over the whole text,
 * comments and literals included, so it errs only one way: it may suspect a transaction
 * where there is none (and then a request is not run again on a replacement session), never
 * the other way round.
 */
export function mayOpenTransaction(sql: string): boolean {
  return /\b(?:begin|start\s+transaction|autocommit)\b/i.test(sql);
}

/**
 * Whether `sql` changes the session's state in a way a replacement session would not have:
 * a statement whose first word is `USE`, `SET`, `RESET` or `PRAGMA` (its catalog and schema,
 * its settings). The first word of the text and of every part after a `;` counts, comments
 * skipped, so `UPDATE t SET ...` does not; a `;` inside a literal only makes it suspect more.
 */
export function changesSessionState(sql: string): boolean {
  for (const part of sql.split(";")) {
    const head = part.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, "");
    if (/^(?:use|set|reset|pragma)\b/iu.test(head)) return true;
  }
  return false;
}

const replacedNote = (oldId: string, newId: string): string =>
  ` (note: the server lost session ${oldId} and this ran in replacement session ${newId}, which has the ` +
  `connection's options but not the old session's temporary tables, SQL-level settings or prepared statements)`;

/** `lost` for sessionLostError when a transaction may have been open, which the client can't tell. */
export const maybeTransaction = "\u0000maybe-transaction";

/** `lost` for sessionLostError when SQL changed the session's settings or search path (changesSessionState). */
export const lostSessionState = "\u0000session-state";

/** The error for an operation that could not run because its session is gone (§5.6). */
export function sessionLostError(
  cause: ChargewireError,
  oldId: string,
  newId: string | undefined,
  lost: string,
): ChargewireError {
  let message = `the server no longer has session ${oldId} (${cause.message})`;
  if (lost === maybeTransaction) {
    message +=
      "; SQL that can begin a transaction (BEGIN, START TRANSACTION, autocommit) ran in it, so a " +
      "transaction may have been open there and is gone, and this did not run again";
  } else if (lost === lostSessionState) {
    message +=
      "; SQL that changes the session's settings (USE, SET, RESET or PRAGMA) ran in it, and those settings are " +
      "gone with it (the replacement has only the connection's options), so this did not run again";
  } else if (lost !== "") message += `; the ${lost} that lived in it is gone`;
  message +=
    newId !== undefined
      ? `; the client opened session ${newId} with the connection's options, so the connection can be used again`
      : "; the connection must be reopened";
  return cause.with({ message, cause, lostSessionId: oldId, replacementSessionId: newId });
}

/**
 * Whether setting `options` leaves the session in the catalog's default schema: the catalog is
 * among them, without a schema (`refused`: the options the server did not take, which count as
 * not given). Setting the catalog moves the session to that catalog's default schema, as SQL `USE`
 * does, so a schema remembered from before must be forgotten: replayed with the catalog, it would
 * open a replacement session in a schema of that name in the new catalog instead of where the lost
 * session was, or fail every replacement when the new catalog has no such schema.
 */
function movesToDefaultSchema(options: Record<string, unknown>, refused: Record<string, unknown> = {}): boolean {
  const took = (key: string): boolean => Object.hasOwn(options, key) && !Object.hasOwn(refused, key);
  return took("catalog") && !took("schema");
}

/**
 * A server session (§5) and the options the client set on it. When the server reports
 * the session gone, a replacement is opened with the same options (when allowed) and
 * the loss is reported, not hidden. The options are remembered in the order they were set,
 * so the replacement opens where the lost session was (movesToDefaultSchema).
 */
export class Session {
  readonly #http: HttpClient;
  readonly #reconnect: boolean;
  #id: string;
  readonly #options: Record<string, unknown>;
  #replacements = 0;
  #closed = false;
  #replacing: { failedId: string; promise: Promise<string> } | undefined;
  /** The sessions in which SQL ran that may have opened a transaction (mayOpenTransaction). */
  readonly #maybeTransactionIn = new Set<string>();
  /** The sessions in which SQL ran that set a catalog or schema (`USE`), which setOptions can restore. */
  readonly #searchPathIn = new Set<string>();
  /** The sessions in which SQL ran that changed other session state (`SET`, `RESET`, `PRAGMA`). */
  readonly #settingsIn = new Set<string>();
  /**
   * Sessions the client gave up on because a clean-up could not reach them (tidyTransaction):
   * the next request treats each as lost, with this error, and opens a replacement.
   */
  readonly #abandoned = new Map<string, ChargewireError>();
  /** The idle timeout the server announced. */
  idleTimeoutS: number | undefined;
  /** Whether the session exists on the server: false for a lazy one until its first request. */
  #opened: boolean;
  /** The sign-in and session creation under way for a lazy session (ensureOpen). */
  #opening: Promise<void> | undefined;
  /**
   * Options set on a lazy session before it opened (setOptions never signs in): sent right after
   * the session is created, before its first request, which a refusal fails.
   */
  readonly #pendingOptions = new Map<string, unknown>();

  private constructor(
    http: HttpClient,
    reconnect: boolean,
    options: Record<string, unknown>,
    doc: SessionDocument | undefined,
  ) {
    this.#http = http;
    this.#reconnect = reconnect;
    this.#options = options;
    this.#id = doc?.session_id ?? "";
    this.idleTimeoutS = doc?.idle_timeout_s;
    this.#opened = doc !== undefined;
  }

  /** Creates a session (§5.1). */
  static async open(
    http: HttpClient,
    options: Record<string, unknown>,
    reconnect: boolean,
    signal?: AbortSignal,
  ): Promise<Session> {
    const copy = { ...options };
    const doc = await create(http, copy, signal);
    return new Session(http, reconnect, copy, doc);
  }

  /**
   * A session that is signed in for and created at its first request that does work (lazy
   * connect to a stopped server, §11.2): until then nothing is sent, so nothing starts the server.
   */
  static lazy(http: HttpClient, options: Record<string, unknown>, reconnect: boolean): Session {
    return new Session(http, reconnect, { ...options }, undefined);
  }

  /** Whether the session exists on the server yet (a lazy one: not before its first request). */
  get opened(): boolean {
    return this.#opened;
  }

  /**
   * Signs in and creates a lazy session, once; does nothing for one that is open. The sign-in
   * is what starts a stopped server, so this runs only for a request that does work. A failure
   * (wrong credentials, a server that can't be reached) is that request's error, and the next
   * request tries again.
   */
  async ensureOpen(signal?: AbortSignal): Promise<void> {
    if (this.#opened && this.#pendingOptions.size === 0) return;
    this.#checkOpen();
    this.#opening ??= (async () => {
      if (!this.#opened) {
        await this.#http.authenticate(signal);
        const doc = await create(this.#http, this.#options, signal);
        this.#id = doc.session_id;
        this.idleTimeoutS = doc.idle_timeout_s;
        this.#opened = true;
      }
      if (this.#pendingOptions.size === 0) return;
      const pending = Object.fromEntries(this.#pendingOptions);
      this.#pendingOptions.clear();
      let result: OptionsResult;
      try {
        const resp = await this.#http.request({
          method: "PATCH",
          path: sessionPath(this.#id),
          body: jsonBody({ options: pending }),
          idempotent: true,
          signal,
        });
        result = await decodeJSON<OptionsResult>(resp);
      } catch (err) {
        // Not answered: send them with the next request.
        for (const [key, value] of Object.entries(pending))
          if (!this.#pendingOptions.has(key)) this.#pendingOptions.set(key, value);
        throw err;
      }
      const refused = this.#settled(pending, result);
      if (refused !== undefined) throw refused; // this first request's error
    })().finally(() => {
      this.#opening = undefined;
    });
    await this.#opening;
  }

  get http(): HttpClient {
    return this.#http;
  }

  get id(): string {
    return this.#id;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** How many times the session was lost and replaced. */
  get replacements(): number {
    return this.#replacements;
  }

  /** Whether the client turned autocommit off (on a lazy session: set to, before it opened). */
  get inTransaction(): boolean {
    const pending = this.#pendingOptions.has("autocommit");
    return (pending ? this.#pendingOptions.get("autocommit") : this.#options["autocommit"]) === false;
  }

  /** Records SQL sent to session `sessionId` (a statement, or a statement prepared there). */
  noteSql(sessionId: string, sql: string): void {
    if (mayOpenTransaction(sql)) this.#maybeTransactionIn.add(sessionId);
    if (changesSessionState(sql)) {
      // USE alone sets only the search path, which catalog and schema session options restore.
      const onlyUse = sql
        .split(";")
        .map((part) => part.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, ""))
        .every((head) => !/^(?:set|reset|pragma)\b/iu.test(head));
      (onlyUse ? this.#searchPathIn : this.#settingsIn).add(sessionId);
    }
  }

  /**
   * What may have been lost with session `sessionId` that makes running a request again on a
   * replacement unsafe: `open transaction` (autocommit is off, or the server said so),
   * `maybeTransaction` (SQL that can begin one ran there, §5.7), `lostSessionState` (SQL changed
   * its settings or search path, which the replacement does not have), or `""` when none of that.
   * Decided from the SQL the client sent, never from a read of the session document, which a
   * server before Chargewire 2.2.1 can answer before it has recorded a statement's effect.
   */
  transactionLost(sessionId: string, err: ChargewireError): string {
    if (this.inTransaction || lostTransaction(err)) return "open transaction";
    if (this.#maybeTransactionIn.has(sessionId)) return maybeTransaction;
    // A replacement has the connection's options but not what SQL set: a request run again there
    // could write to another schema's table, or run with other settings, without an error.
    if (this.#settingsIn.has(sessionId) || this.#searchPathIn.has(sessionId)) return lostSessionState;
    return "";
  }

  /** The options set through this session, replayed on a replacement. */
  get options(): Readonly<Record<string, unknown>> {
    return this.#options;
  }

  #checkOpen(): void {
    if (this.#closed)
      throw new ChargewireError({ code: ErrorCode.clientConnectionClosed, message: "the connection is closed" });
  }

  /** Opens a replacement for session `failedId`, unless that already happened; returns the current id. */
  async #replace(failedId: string, cause: ChargewireError, tokenUsed: string | undefined): Promise<string> {
    this.#checkOpen();
    if (this.#id !== failedId) return this.#id;
    if (this.#replacing?.failedId === failedId) return this.#replacing.promise;
    const promise = (async () => {
      if (
        cause.code === ErrorCode.sessionEnded &&
        cause.reason !== "idle_in_transaction" &&
        this.#http.currentToken === tokenUsed
      ) {
        // §5.6: get a new access token before creating a new session (unless the request that
        // found the session gone already did, after its own invalid_token). A session ended
        // for its idle transaction says nothing about the token, which stays.
        await this.#http.renewToken(tokenUsed);
      }
      const doc = await create(this.#http, this.#options);
      if (this.#abandoned.has(failedId)) {
        // Signed in again now: end the session given up on, and whatever it still held.
        void this.#http
          .void({
            method: "DELETE",
            path: sessionPath(failedId),
            idempotent: true,
            resume: false,
            renew: false,
            signal: AbortSignal.timeout(tidyTimeoutMs),
          })
          .catch(() => {});
      }
      this.#id = doc.session_id;
      this.idleTimeoutS = doc.idle_timeout_s;
      this.#replacements++;
      this.#http.logger.warn?.(
        "the server lost the session; opened a replacement with the same options (temporary tables, " +
          "SQL-level settings and prepared statements of the old session are gone)",
        { oldSession: failedId, newSession: doc.session_id, cause: cause.message },
      );
      return doc.session_id;
    })();
    this.#replacing = { failedId, promise };
    try {
      return await promise;
    } finally {
      if (this.#replacing?.promise === promise) this.#replacing = undefined;
    }
  }

  /** Sends a request built for the current session, and handles the session being gone as `scope` allows. */
  async do(
    scope: Scope,
    lostWhat: string,
    build: (sessionId: string) => HttpRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    this.#checkOpen();
    await this.ensureOpen(signal);
    const id = this.#id;
    const req = build(id);
    const tokenUsed = this.#http.currentToken;
    const abandoned = this.#abandoned.get(id);
    try {
      if (abandoned !== undefined) throw abandoned; // never sent: the session was given up
      return await this.#http.request(req);
    } catch (err) {
      if (!isSessionLost(err, this.#http.canRenew)) throw err;
      if (!this.#reconnect) throw sessionLostError(err, id, undefined, lostWhat);
      let newId: string;
      try {
        newId = await this.#replace(id, err, tokenUsed);
      } catch (replaceErr) {
        throw sessionLostError(err, id, undefined, lostWhat).with({
          message:
            sessionLostError(err, id, undefined, lostWhat).message +
            `; opening a replacement failed: ${String(replaceErr)}`,
        });
      }
      if (scope === "handle") throw sessionLostError(err, id, newId, lostWhat);
      // §5.7: never run a request again on the replacement unless no transaction was open in
      // the lost session. A session ended for an idle transaction had one, whether the client
      // turned autocommit off or the SQL ran BEGIN; after session_not_found the client can't
      // tell, unless no SQL that can begin one ran there. A statement run again would commit
      // on its own; a session request (options, metadata) run again would hide the loss, and
      // the next statement would.
      const lostTransactionWhat = this.transactionLost(id, err);
      if (lostTransactionWhat !== "") throw sessionLostError(err, id, newId, lostTransactionWhat);
      if (abandoned === undefined && req.body?.stream !== undefined) {
        throw sessionLostError(err, id, newId, "upload (it streamed, so it cannot be sent again)");
      }
      try {
        return await this.#http.request(build(newId));
      } catch (retryErr) {
        if (retryErr instanceof ChargewireError)
          throw retryErr.with({ message: retryErr.message + replacedNote(id, newId) });
        throw retryErr;
      }
    }
  }

  /** Sends a request about a handle that lives in session `sessionId`, which may no longer be the current one. */
  async doHandle(sessionId: string, what: string, req: HttpRequest): Promise<Response> {
    this.#checkOpen();
    const tokenUsed = this.#http.currentToken;
    try {
      const abandoned = this.#abandoned.get(sessionId);
      if (abandoned !== undefined) throw abandoned;
      return await this.#http.request(req);
    } catch (err) {
      if (!isSessionLost(err, this.#http.canRenew)) throw err;
      if (sessionId !== this.#id || !this.#reconnect) throw sessionLostError(err, sessionId, undefined, what);
      let newId: string | undefined;
      try {
        newId = await this.#replace(sessionId, err, tokenUsed);
      } catch {
        newId = undefined;
      }
      throw sessionLostError(err, sessionId, newId, what);
    }
  }

  /** Reads the session document (§5.2). */
  async get(signal?: AbortSignal): Promise<SessionDocument> {
    const resp = await this.do(
      "session",
      "",
      (id) => ({ method: "GET", path: sessionPath(id), idempotent: true, signal }),
      signal,
    );
    const doc = await decodeJSON<SessionDocument>(resp);
    return { ...doc, transaction: transactionState(doc.transaction) };
  }

  /**
   * Sets session options (§5.3), remembering the ones the server took so a replacement gets them.
   * Setting the catalog without a schema forgets the schema remembered from before
   * (movesToDefaultSchema), on an open session and on a lazy one that hasn't opened.
   */
  async setOptions(options: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.#checkOpen();
    if (!this.#opened && this.#opening !== undefined) await this.#opening.catch(() => {});
    if (!this.#opened) {
      // A lazy session that hasn't opened: setting options is not work, so it never signs in.
      // Kept in the order they were set, like an open session's: the catalog set after the schema
      // moves to the catalog's default schema, so that schema is not sent when the session opens.
      for (const [key, value] of Object.entries(options)) this.#pendingOptions.set(key, value);
      if (movesToDefaultSchema(options)) this.#pendingOptions.delete("schema");
      const set = { ...this.#options, ...Object.fromEntries(this.#pendingOptions) };
      // A schema the session is created with (given to connect) is gone once the catalog is set.
      if (movesToDefaultSchema(Object.fromEntries(this.#pendingOptions))) delete set["schema"];
      return set;
    }
    const body = jsonBody({ options });
    const resp = await this.do(
      "session",
      "",
      (id) => ({ method: "PATCH", path: sessionPath(id), body, idempotent: true, signal }),
      signal,
    );
    const result = await decodeJSON<OptionsResult>(resp);
    const refused = this.#settled(options, result);
    if (refused !== undefined) throw refused;
    return result.options ?? {};
  }

  /** Records the options the server took; returns the error for the first one it refused. */
  #settled(options: Record<string, unknown>, result: OptionsResult): ChargewireError | undefined {
    const errors = result.errors ?? {};
    for (const [key, value] of Object.entries(options)) {
      if (!Object.hasOwn(errors, key)) this.#options[key] = value;
    }
    // The catalog set without a schema: the session is now in that catalog's default schema, and
    // so must its replacement be. The schema set before is not replayed.
    if (movesToDefaultSchema(options, errors)) delete this.#options["schema"];
    // Catalog and schema set as options now decide the search path, and a replacement gets them:
    // a USE before this is restored.
    const set = (key: string): boolean => Object.hasOwn(options, key) && !Object.hasOwn(errors, key);
    if (set("catalog") && set("schema")) this.#searchPathIn.delete(this.#id);
    const refused = Object.keys(errors).sort();
    if (refused.length > 0) {
      const key = refused[0]!;
      const problem = problemError(errors[key], { status: 400 });
      return problem.with({ message: `session option ${JSON.stringify(key)}: ${problem.message}` });
    }
    return undefined;
  }

  /**
   * Ends the session (§5.4). One the server no longer has counts as closed. Never replaced
   * afterwards, and never a reason to sign in: sent with the token the client has.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#opening !== undefined) await this.#opening.catch(() => {});
    if (!this.#opened) return; // a lazy session never opened: nothing to end, nothing sent
    try {
      // A stopped server (server_resuming) holds no sessions: closed too, without waiting for it.
      // A refused token (invalid_token) means the session is gone or going with it.
      await this.#http.void({
        method: "DELETE",
        path: sessionPath(this.#id),
        idempotent: true,
        resume: false,
        renew: false,
      });
    } catch (err) {
      if (ChargewireError.is(err, ErrorCode.sessionNotFound, ErrorCode.serverResuming, ErrorCode.invalidToken)) return;
      throw err;
    }
  }

  /**
   * `transaction()`'s clean-up: rolls the transaction back (`rollback`) and turns autocommit
   * back on. Never signs in, never opens a session and never waits for a resuming server: it
   * goes with the token the client has, for at most `tidyTimeoutMs` per request. Never fails.
   * A session the server no longer has (or a stopped server) is gone with its transaction. When
   * the clean-up can't tell (the token was refused, no answer), the session may still hold the
   * transaction or autocommit off, so the client gives it up: the next request opens a
   * replacement, as for a lost session, and deletes the old one.
   */
  async tidyTransaction(rollback: boolean): Promise<void> {
    if (this.#closed) return;
    if (!this.#opened) return this.#autocommitOn(); // a lazy session: nothing was sent
    const id = this.#id;
    const send = (req: Omit<HttpRequest, "resume" | "renew" | "signal">): Promise<Response> =>
      this.#http.request({ ...req, resume: false, renew: false, signal: AbortSignal.timeout(tidyTimeoutMs) });
    const gone = (err: unknown): boolean =>
      ChargewireError.is(err, ErrorCode.sessionNotFound, ErrorCode.sessionEnded, ErrorCode.serverResuming);
    let unsure: unknown;
    if (rollback) {
      try {
        await discard(await send({ method: "POST", path: `${sessionPath(id)}/rollback`, idempotent: false }));
      } catch (err) {
        if (gone(err)) return this.#autocommitOn();
        // A refusal about the request (no transaction open) leaves the session as it was.
        if (!(err instanceof ChargewireError) || err.status === undefined || err.status === 401 || err.status >= 500)
          unsure = err;
      }
    }
    if (unsure === undefined) {
      try {
        const resp = await send({
          method: "PATCH",
          path: sessionPath(id),
          body: jsonBody({ options: { autocommit: true } }),
          idempotent: true,
        });
        const result = await decodeJSON<OptionsResult>(resp);
        if (!Object.hasOwn(result.errors ?? {}, "autocommit")) return this.#autocommitOn();
        unsure = problemError(result.errors?.["autocommit"], { status: 400 });
      } catch (err) {
        if (gone(err)) return this.#autocommitOn();
        unsure = err;
      }
    }
    // Don't send anything more to it: autocommit on with a transaction still open would commit it.
    this.#autocommitOn();
    const cause = unsure instanceof ChargewireError ? unsure.message : String(unsure);
    this.#abandoned.set(
      id,
      new ChargewireError({
        code: ErrorCode.sessionNotFound,
        message: `the client gave up the session: ending its transaction did not reach the server (${cause})`,
        cause: unsure,
      }),
    );
    this.#http.logger.warn?.("transaction clean-up could not reach the server; the next request opens a new session", {
      session: id,
      cause,
    });
  }

  #autocommitOn(): void {
    this.#pendingOptions.delete("autocommit");
    this.#options["autocommit"] = true;
  }

  /** Ends the current transaction (§5.5). Never retried: a commit whose answer was lost may have happened. */
  async commit(signal?: AbortSignal): Promise<void> {
    await this.#endTransaction("commit", signal);
  }

  async rollback(signal?: AbortSignal): Promise<void> {
    await this.#endTransaction("rollback", signal);
  }

  async #endTransaction(action: "commit" | "rollback", signal: AbortSignal | undefined): Promise<void> {
    this.#checkOpen();
    // Before a lazy session opened, nothing ran: the transaction is empty, and ending it is not work.
    if (!this.#opened && this.#opening === undefined) return;
    await this.ensureOpen(signal);
    const id = this.#id;
    const resp = await this.doHandle(id, "open transaction", {
      method: "POST",
      path: `${sessionPath(id)}/${action}`,
      idempotent: false,
      signal,
    });
    await discard(resp);
  }
}

async function create(
  http: HttpClient,
  options: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SessionDocument> {
  // Creating a session is not idempotent, but a retry after a lost answer only leaves an
  // unused session behind, which the server evicts when idle.
  const doc = await http.json<SessionDocument>({
    method: "POST",
    path: "/v1/sessions",
    body: jsonBody({ options }),
    idempotent: true,
    signal,
  });
  if (typeof doc.session_id !== "string" || doc.session_id === "") {
    throw protocolError("the server created a session without an id");
  }
  return doc;
}

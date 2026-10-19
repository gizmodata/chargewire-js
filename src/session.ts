// Licensed under the Apache License, Version 2.0.

import { ErrorCode, WarpSqlError, problemError, protocolError } from "./errors.js";
import { type HttpClient, type HttpRequest, decodeJSON, discard, jsonBody } from "./http.js";
import { type OptionsResult, type SessionDocument, transactionState } from "./protocol.js";

/**
 * What a request may do when the server no longer has its session (§5.6). The server
 * never recreates a session, so the client decides.
 *
 * - `session`: acts on the session as a whole (options, metadata, preparing); runs
 *   again on a replacement session.
 * - `statement`: runs SQL; runs again on a replacement only outside a transaction
 *   (inside one, the work before it is gone, and running the rest would commit half a
 *   transaction).
 * - `handle`: names something that lived in the lost session (a statement, a prepared
 *   statement, the open transaction); fails.
 */
export type Scope = "session" | "statement" | "handle";

export function sessionPath(id: string): string {
  return "/v1/sessions/" + encodeURIComponent(id);
}

/**
 * Whether `err` says the session is gone in a way a new session cures (§5.6): the server
 * doesn't have it (`session_not_found`), or ended it because its token expired and the
 * client can get a new token (`canRenew`), which it must before opening a new session.
 * After `credentials_changed`, `principal_dropped` or `token_revoked` the client may not sign
 * in again on its own (§4.2), and an administrator's `killed` (or a reason the client
 * doesn't know) is reported, not papered over: those are the error.
 */
export function isSessionLost(err: unknown, canRenew: boolean): err is WarpSqlError {
  return (
    err instanceof WarpSqlError &&
    (err.code === ErrorCode.sessionNotFound ||
      (err.code === ErrorCode.sessionEnded && err.reason === "token_expired" && canRenew))
  );
}

const replacedNote = (oldId: string, newId: string): string =>
  ` (note: the server lost session ${oldId} and this ran in replacement session ${newId}, which has the ` +
  `connection's options but not the old session's temporary tables, SQL-level settings or prepared statements)`;

/** The error for an operation that could not run because its session is gone (§5.6). */
export function sessionLostError(
  cause: WarpSqlError,
  oldId: string,
  newId: string | undefined,
  lost: string,
): WarpSqlError {
  let message = `the server no longer has session ${oldId} (${cause.message})`;
  if (lost !== "") message += `; the ${lost} that lived in it is gone`;
  message +=
    newId !== undefined
      ? `; the client opened session ${newId} with the connection's options, so the connection can be used again`
      : "; the connection must be reopened";
  return cause.with({ message, cause, lostSessionId: oldId, replacementSessionId: newId });
}

/**
 * A server session (§5) and the options the client set on it. When the server reports
 * the session gone, a replacement is opened with the same options (when allowed) and
 * the loss is reported, not hidden.
 */
export class Session {
  readonly #http: HttpClient;
  readonly #reconnect: boolean;
  #id: string;
  readonly #options: Record<string, unknown>;
  #replacements = 0;
  #closed = false;
  #replacing: { failedId: string; promise: Promise<string> } | undefined;
  /** The idle timeout the server announced. */
  idleTimeoutS: number | undefined;

  private constructor(http: HttpClient, reconnect: boolean, options: Record<string, unknown>, doc: SessionDocument) {
    this.#http = http;
    this.#reconnect = reconnect;
    this.#options = options;
    this.#id = doc.session_id;
    this.idleTimeoutS = doc.idle_timeout_s;
  }

  /** Creates a session (§5.1). */
  static async open(http: HttpClient, options: Record<string, unknown>, reconnect: boolean): Promise<Session> {
    const copy = { ...options };
    const doc = await create(http, copy);
    return new Session(http, reconnect, copy, doc);
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

  /** Whether the client turned autocommit off. */
  get inTransaction(): boolean {
    return this.#options["autocommit"] === false;
  }

  /** The options set through this session, replayed on a replacement. */
  get options(): Readonly<Record<string, unknown>> {
    return this.#options;
  }

  #checkOpen(): void {
    if (this.#closed)
      throw new WarpSqlError({ code: ErrorCode.clientConnectionClosed, message: "the connection is closed" });
  }

  /** Opens a replacement for session `failedId`, unless that already happened; returns the current id. */
  async #replace(failedId: string, cause: WarpSqlError, tokenUsed: string | undefined): Promise<string> {
    this.#checkOpen();
    if (this.#id !== failedId) return this.#id;
    if (this.#replacing?.failedId === failedId) return this.#replacing.promise;
    const promise = (async () => {
      if (cause.code === ErrorCode.sessionEnded && this.#http.currentToken === tokenUsed) {
        // §5.6: get a new access token before creating a new session (unless the request that
        // found the session gone already did, after its own invalid_token).
        await this.#http.renewToken(tokenUsed);
      }
      const doc = await create(this.#http, this.#options);
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
  async do(scope: Scope, lostWhat: string, build: (sessionId: string) => HttpRequest): Promise<Response> {
    this.#checkOpen();
    const id = this.#id;
    const req = build(id);
    const tokenUsed = this.#http.currentToken;
    try {
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
      if (scope === "statement" && this.inTransaction) throw sessionLostError(err, id, newId, "open transaction");
      if (req.body?.stream !== undefined) {
        throw sessionLostError(err, id, newId, "upload (it streamed, so it cannot be sent again)");
      }
      try {
        return await this.#http.request(build(newId));
      } catch (retryErr) {
        if (retryErr instanceof WarpSqlError)
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
    const resp = await this.do("session", "", (id) => ({
      method: "GET",
      path: sessionPath(id),
      idempotent: true,
      signal,
    }));
    const doc = await decodeJSON<SessionDocument>(resp);
    return { ...doc, transaction: transactionState(doc.transaction) };
  }

  /** Sets session options (§5.3), remembering the ones the server took so a replacement gets them. */
  async setOptions(options: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = jsonBody({ options });
    const resp = await this.do("session", "", (id) => ({
      method: "PATCH",
      path: sessionPath(id),
      body,
      idempotent: true,
      signal,
    }));
    const result = await decodeJSON<OptionsResult>(resp);
    const errors = result.errors ?? {};
    for (const [key, value] of Object.entries(options)) {
      if (!Object.hasOwn(errors, key)) this.#options[key] = value;
    }
    const refused = Object.keys(errors).sort();
    if (refused.length > 0) {
      const key = refused[0]!;
      const problem = problemError(errors[key], { status: 400 });
      throw problem.with({ message: `session option ${JSON.stringify(key)}: ${problem.message}` });
    }
    return result.options ?? {};
  }

  /** Ends the session (§5.4). One the server no longer has counts as closed. Never replaced afterwards. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#http.void({ method: "DELETE", path: sessionPath(this.#id), idempotent: true });
    } catch (err) {
      if (WarpSqlError.is(err, ErrorCode.sessionNotFound)) return;
      throw err;
    }
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

async function create(http: HttpClient, options: Record<string, unknown>): Promise<SessionDocument> {
  // Creating a session is not idempotent, but a retry after a lost answer only leaves an
  // unused session behind, which the server evicts when idle.
  const doc = await http.json<SessionDocument>({
    method: "POST",
    path: "/v1/sessions",
    body: jsonBody({ options }),
    idempotent: true,
  });
  if (typeof doc.session_id !== "string" || doc.session_id === "") {
    throw protocolError("the server created a session without an id");
  }
  return doc;
}

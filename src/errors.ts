// Licensed under the Apache License, Version 2.0.

/**
 * Error codes. The server's codes are spec §11's; a code the client does not know is
 * kept as the server sent it and judged by its HTTP status (§12). The client adds a few
 * of its own for failures that have no server answer.
 */
export const ErrorCode = {
  // Spec §11.
  badRequest: "bad_request",
  unknownOption: "unknown_option",
  invalidOptionValue: "invalid_option_value",
  sqlError: "sql_error",
  invalidCredentials: "invalid_credentials",
  invalidToken: "invalid_token",
  sessionEnded: "session_ended",
  permissionDenied: "permission_denied",
  readOnly: "read_only",
  sessionNotFound: "session_not_found",
  statementNotFound: "statement_not_found",
  preparedNotFound: "prepared_not_found",
  ingestNotFound: "ingest_not_found",
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  resultNotReady: "result_not_ready",
  resultNotResumable: "result_not_resumable",
  resultExpired: "result_expired",
  ingestIncomplete: "ingest_incomplete",
  ingestPartExists: "ingest_part_exists",
  ingestExpired: "ingest_expired",
  payloadTooLarge: "payload_too_large",
  unsupportedArrowType: "unsupported_arrow_type",
  sessionElsewhere: "session_elsewhere",
  idempotencyKeyReused: "idempotency_key_reused",
  headersTooLarge: "headers_too_large",
  tooManySessions: "too_many_sessions",
  resultQuotaExceeded: "result_quota_exceeded",
  rateLimited: "rate_limited",
  statementTimeout: "statement_timeout",
  statementCancelled: "statement_cancelled",
  executionError: "execution_error",
  serverDraining: "server_draining",
  notImplemented: "not_implemented",

  // Client-side: no server answer carries these.
  /** An argument or option the client refuses before sending anything. */
  invalidArgument: "invalid_argument",
  /** The request got no HTTP answer (connection refused, reset, TLS failure). */
  transportError: "transport_error",
  /** The server answered something that does not follow the protocol. */
  protocolError: "protocol_error",
  /** An Arrow stream ended without its end-of-stream marker and could not be resumed (§6.6). */
  incompleteStream: "incomplete_stream",
  /** A streamed result was set aside for another request and did not fit the buffer. */
  resultBufferExceeded: "result_buffer_exceeded",
  /** The connection was closed. */
  connectionClosed: "connection_closed",
} as const;

export type KnownErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Why a session ended (§5.6), on `session_ended` errors. */
export type SessionEndedReason = "killed" | "credentials_changed" | "principal_dropped" | "token_expired";

/** An RFC 9457 problem document as the server sends it (§11). */
export interface ProblemDocument {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  sqlstate?: string;
  request_id?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface WarpSqlErrorInit {
  code: string;
  message?: string;
  status?: number;
  detail?: string;
  title?: string;
  type?: string;
  sqlstate?: string;
  requestId?: string;
  reason?: string;
  retryAfterMs?: number;
  statementId?: string;
  cancelReason?: string;
  problem?: ProblemDocument;
  lostSessionId?: string;
  replacementSessionId?: string;
  cause?: unknown;
}

/**
 * Every error the client raises. `code` is the stable, machine-readable part: the
 * server's problem-document code (§11) or one of the client codes in {@link ErrorCode}.
 */
export class WarpSqlError extends Error {
  override readonly name = "WarpSqlError";
  /** The error code, e.g. `sql_error` or `statement_cancelled`. */
  readonly code: string;
  /** The HTTP status of the answer that carried the error, when there was one. */
  readonly status: number | undefined;
  /** The server's explanation, for people. */
  readonly detail: string | undefined;
  readonly title: string | undefined;
  readonly type: string | undefined;
  /** The SQL standard's five-character SQLSTATE, when the server sent one. */
  readonly sqlstate: string | undefined;
  /** The server's id for the request (`Warp-Request-Id`), also in its logs. */
  readonly requestId: string | undefined;
  /** On `session_ended`: why (§5.6). */
  readonly reason: string | undefined;
  /** The server's `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  /** The statement the error belongs to, when known. */
  readonly statementId: string | undefined;
  /** On a cancelled statement: why (§6.2). */
  readonly cancelReason: string | undefined;
  /** The problem document as received. */
  readonly problem: ProblemDocument | undefined;
  /** The session the server no longer has, when the error is about a lost session (§5.6). */
  readonly lostSessionId: string | undefined;
  /** The session the client opened in its place, if it did (the connection is usable again). */
  readonly replacementSessionId: string | undefined;

  constructor(init: WarpSqlErrorInit) {
    super(init.message ?? describe(init), init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.detail = init.detail;
    this.title = init.title;
    this.type = init.type;
    this.sqlstate = init.sqlstate;
    this.requestId = init.requestId;
    this.reason = init.reason;
    this.retryAfterMs = init.retryAfterMs;
    this.statementId = init.statementId;
    this.cancelReason = init.cancelReason;
    this.problem = init.problem;
    this.lostSessionId = init.lostSessionId;
    this.replacementSessionId = init.replacementSessionId;
  }

  /** Whether `err` is a WarpSqlError, and (when given) has one of the codes. */
  static is(err: unknown, ...codes: string[]): err is WarpSqlError {
    return err instanceof WarpSqlError && (codes.length === 0 || codes.includes(err.code));
  }

  /** A copy with another message and extra fields, keeping the rest. */
  with(changes: Partial<WarpSqlErrorInit>): WarpSqlError {
    return new WarpSqlError({ ...this.init(), ...changes });
  }

  private init(): WarpSqlErrorInit {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      detail: this.detail,
      title: this.title,
      type: this.type,
      sqlstate: this.sqlstate,
      requestId: this.requestId,
      reason: this.reason,
      retryAfterMs: this.retryAfterMs,
      statementId: this.statementId,
      cancelReason: this.cancelReason,
      problem: this.problem,
      lostSessionId: this.lostSessionId,
      replacementSessionId: this.replacementSessionId,
      cause: this.cause,
    };
  }
}

function describe(init: WarpSqlErrorInit): string {
  let text = init.detail || init.title || "request failed";
  const extra = [init.code];
  if (init.reason) extra.push(`reason: ${init.reason}`);
  if (init.sqlstate) extra.push(`SQLSTATE ${init.sqlstate}`);
  if (init.status) extra.push(`HTTP ${init.status}`);
  if (init.requestId) extra.push(`request ${init.requestId}`);
  text += ` (${extra.join(", ")})`;
  return text;
}

/** The code an answer without a problem document stands for (a proxy's HTML page, say). */
export function codeForStatus(status: number): string {
  switch (status) {
    case 401:
      return ErrorCode.invalidToken;
    case 403:
      return ErrorCode.permissionDenied;
    case 404:
      return ErrorCode.notFound;
    case 405:
      return ErrorCode.methodNotAllowed;
    case 413:
      return ErrorCode.payloadTooLarge;
    case 429:
      return ErrorCode.rateLimited;
    case 431:
      return ErrorCode.headersTooLarge;
    case 501:
      return ErrorCode.notImplemented;
    case 503:
      return ErrorCode.serverDraining;
  }
  return status >= 500 ? ErrorCode.executionError : ErrorCode.badRequest;
}

/** A problem document (from an answer or inside a statement document) as an error. */
export function problemError(
  problem: ProblemDocument | undefined,
  context: {
    status?: number;
    requestId?: string | null;
    retryAfterMs?: number;
    statementId?: string;
    cancelReason?: string;
  } = {},
): WarpSqlError {
  const doc: ProblemDocument = problem ?? {};
  const status = typeof doc.status === "number" && doc.status > 0 ? doc.status : context.status;
  const code = typeof doc.code === "string" && doc.code !== "" ? doc.code : codeForStatus(status ?? 500);
  return new WarpSqlError({
    code,
    status,
    detail: str(doc.detail),
    title: str(doc.title),
    type: str(doc.type),
    sqlstate: str(doc.sqlstate),
    requestId: str(doc.request_id) ?? context.requestId ?? undefined,
    reason: str(doc.reason),
    retryAfterMs: context.retryAfterMs,
    statementId: context.statementId,
    cancelReason: context.cancelReason,
    problem,
  });
}

const maxProblemBytes = 1 << 20;

/** Turns an error answer into a WarpSqlError, whatever its body is. */
export async function responseError(resp: Response): Promise<WarpSqlError> {
  let text = "";
  try {
    text = await resp.text();
  } catch {
    // The body could not be read; the status still says what happened.
  }
  if (text.length > maxProblemBytes) text = text.slice(0, maxProblemBytes);
  const retryAfterMs = parseRetryAfter(resp.headers.get("retry-after"));
  const requestId = resp.headers.get("warp-request-id");
  let doc: ProblemDocument | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as ProblemDocument).code === "string") {
      doc = parsed as ProblemDocument;
    }
  } catch {
    // Not JSON.
  }
  if (doc === undefined) {
    let detail = text.trim();
    if (detail === "" || detail.length > 512) detail = resp.statusText || `HTTP ${resp.status}`;
    return new WarpSqlError({
      code: codeForStatus(resp.status),
      status: resp.status,
      detail,
      requestId: requestId ?? undefined,
      retryAfterMs,
    });
  }
  return problemError(doc, { status: resp.status, requestId, retryAfterMs });
}

/** Reads a Retry-After given in seconds (the HTTP-date form is not used by Warp SQL servers). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed) * 1000;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function invalidArgument(message: string): WarpSqlError {
  return new WarpSqlError({ code: ErrorCode.invalidArgument, message });
}

export function protocolError(message: string, cause?: unknown): WarpSqlError {
  return new WarpSqlError({ code: ErrorCode.protocolError, message, cause });
}

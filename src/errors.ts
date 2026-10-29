// Licensed under the Apache License, Version 2.0.

import { adoptLegacyErrorType } from "./legacy-names.js";

/**
 * Error codes. The server's codes are spec §11's; a code the client does not know is
 * kept as the server sent it and judged by its HTTP status (§12). The client's own codes,
 * for failures it found itself with no problem document from the server, begin with
 * `client_` (§11), a prefix servers never send.
 */
export const ErrorCode = {
  // Spec §11.
  badRequest: "bad_request",
  unknownOption: "unknown_option",
  invalidOptionValue: "invalid_option_value",
  sqlError: "sql_error",
  /** §4.4: a grant the server does not offer, such as client_certificate where certificate sign-in is off. */
  unsupportedGrantType: "unsupported_grant_type",
  invalidCredentials: "invalid_credentials",
  /** §4.2: the token is missing, malformed, expired or no longer stands; `reason` may say why. */
  invalidToken: "invalid_token",
  /** §5.6: the server ended the session; `reason` says why. */
  sessionEnded: "session_ended",
  /** §4.4: the connection presented no client certificate (a server where certificates are optional), or a TLS alert `certificate_required`. */
  certificateRequired: "certificate_required",
  /** §4.4: the certificate has no identity the server maps, several, or one not allowed to sign in. */
  unknownCertificateIdentity: "unknown_certificate_identity",
  /** §4.4: the certificate was revoked, or no longer verifies, after the connection was set up. */
  certificateRevoked: "certificate_revoked",
  /** §4.4: a certificate-bound token on a connection without that certificate. */
  certificateMismatch: "certificate_mismatch",
  /** §4.4: a password or token sign-in for another identity than the connection's certificate. */
  certificateIdentityMismatch: "certificate_identity_mismatch",
  /** §4.3.2: no such browser sign-in flow, a wrong poll secret, or one already collected or expired (404). */
  flowNotFound: "flow_not_found",
  /** §4.3.3: a returnTo that is not a path on the server's own origin (400). */
  invalidReturnTo: "invalid_return_to",
  /** §4.3.2, a failed flow's error.code: the person or the identity provider refused the browser sign-in. */
  accessDenied: "access_denied",
  /** §4.3.2, a failed flow's error.code: the server could not complete the browser sign-in with the identity provider. */
  identityProviderError: "identity_provider_error",
  permissionDenied: "permission_denied",
  readOnly: "read_only",
  sessionNotFound: "session_not_found",
  /** No such statement, or one the server has forgotten (§6.5). */
  statementNotFound: "statement_not_found",
  preparedNotFound: "prepared_not_found",
  ingestNotFound: "ingest_not_found",
  /** §6.4: the result has no partition with that index. */
  partitionNotFound: "partition_not_found",
  /** No such endpoint. */
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  resultNotReady: "result_not_ready",
  resultNotResumable: "result_not_resumable",
  ingestIncomplete: "ingest_incomplete",
  ingestPartExists: "ingest_part_exists",
  /** 409; `cancelReason` says why (§6.2). */
  statementCancelled: "statement_cancelled",
  /** 409: the statement's timeout ran out (§6.9). */
  statementTimeout: "statement_timeout",
  resultExpired: "result_expired",
  ingestExpired: "ingest_expired",
  payloadTooLarge: "payload_too_large",
  unsupportedArrowType: "unsupported_arrow_type",
  sessionElsewhere: "session_elsewhere",
  idempotencyKeyReused: "idempotency_key_reused",
  /** 422: the statement failed while running (a division by zero, a constraint, a conversion). */
  executionError: "execution_error",
  tooManySessions: "too_many_sessions",
  resultQuotaExceeded: "result_quota_exceeded",
  rateLimited: "rate_limited",
  headersTooLarge: "headers_too_large",
  /** 500: the server failed in a way that is not the request's doing. */
  internalError: "internal_error",
  notImplemented: "not_implemented",
  serverDraining: "server_draining",

  // The client's own (§11): no server answer carries these.
  /** An argument or option the client refuses before sending anything. */
  clientInvalidArgument: "client_invalid_argument",
  /** The request got no HTTP answer (connection refused, reset, TLS failure). */
  clientTransportError: "client_transport_error",
  /** The server answered something that does not follow the protocol. */
  clientProtocolError: "client_protocol_error",
  /** An error answer without a problem document (a proxy's page, say); `status` says what it was. */
  clientHttpError: "client_http_error",
  /** An Arrow stream ended without its end-of-stream marker and could not be resumed (§6.6). */
  clientIncompleteStream: "client_incomplete_stream",
  /** A streamed result was set aside for another request and did not fit the buffer. */
  clientResultBufferExceeded: "client_result_buffer_exceeded",
  /** The connection was closed. */
  clientConnectionClosed: "client_connection_closed",
  /** A browser sign-in (§4.3) the person did not complete in the time allowed. */
  clientSignInTimeout: "client_sign_in_timeout",
} as const;

export type KnownErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Why a session ended (§5.6), on `session_ended` errors. Later versions may add reasons
 * (§12): treat one this list lacks as a generic "the session is gone".
 */
export type SessionEndedReason =
  "killed" | "credentials_changed" | "principal_dropped" | "token_revoked" | "token_expired" | (string & {});

/**
 * Why the server refused an authentic token (§4.2), on `invalid_token` errors. Absent for a
 * token the server cannot verify as its own. Later versions may add reasons (§12).
 */
export type InvalidTokenReason =
  "token_expired" | "token_revoked" | "credentials_changed" | "principal_dropped" | (string & {});

/**
 * Why a statement was cancelled (§6.2), on `statement_cancelled` and `statement_timeout`
 * errors. Later versions may add reasons (§12): treat one this list lacks as generic.
 */
export type CancelReason =
  | "client"
  | "timeout"
  | "session_closed"
  | "killed"
  | "cancelled"
  | "privilege_revoked"
  | "server_shutdown"
  | (string & {});

/**
 * Whether an `invalid_token` refusal with this `reason` may be cured by signing in again
 * (§4.2): no reason, `token_expired`, or a reason this client doesn't know. After
 * `token_revoked`, `credentials_changed` or `principal_dropped`, a client does not sign in
 * again on its own, and reports the reason instead.
 */
export function tokenRenewable(reason: string | undefined): boolean {
  return reason !== "token_revoked" && reason !== "credentials_changed" && reason !== "principal_dropped";
}

/** An RFC 9457 problem document as the server sends it (§11). */
export interface ProblemDocument {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  sqlstate?: string;
  request_id?: string;
  /** On `invalid_token` (§4.2) and `session_ended` (§5.6). */
  reason?: string;
  /** On `statement_cancelled` and `statement_timeout` (§6.2). */
  cancel_reason?: string;
  [key: string]: unknown;
}

export interface ChargewireErrorInit {
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
export class ChargewireError extends Error {
  override readonly name = "ChargewireError";
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
  /** The server's id for the request (`Chargewire-Request-Id`), also in its logs. */
  readonly requestId: string | undefined;
  /** On `invalid_token` (§4.2) and `session_ended` (§5.6): why. A value the client doesn't know is a generic one (§12). */
  readonly reason: string | undefined;
  /** The server's `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  /** The statement the error belongs to, when known. */
  readonly statementId: string | undefined;
  /** On a cancelled statement: why (§6.2). A value the client doesn't know is a generic one (§12). */
  readonly cancelReason: string | undefined;
  /** The problem document as received. */
  readonly problem: ProblemDocument | undefined;
  /** The session the server no longer has, when the error is about a lost session (§5.6). */
  readonly lostSessionId: string | undefined;
  /** The session the client opened in its place, if it did (the connection is usable again). */
  readonly replacementSessionId: string | undefined;

  constructor(init: ChargewireErrorInit) {
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

  /** Whether `err` is a ChargewireError, and (when given) has one of the codes. */
  static is(err: unknown, ...codes: string[]): err is ChargewireError {
    return err instanceof ChargewireError && (codes.length === 0 || codes.includes(err.code));
  }

  /** A copy with another message and extra fields, keeping the rest. */
  with(changes: Partial<ChargewireErrorInit>): ChargewireError {
    return new ChargewireError({ ...this.init(), ...changes });
  }

  private init(): ChargewireErrorInit {
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

function describe(init: ChargewireErrorInit): string {
  let text = init.detail || init.title || "request failed";
  const extra = [init.code];
  if (init.reason) extra.push(`reason: ${init.reason}`);
  if (init.sqlstate) extra.push(`SQLSTATE ${init.sqlstate}`);
  if (init.status) extra.push(`HTTP ${init.status}`);
  if (init.requestId) extra.push(`request ${init.requestId}`);
  text += ` (${extra.join(", ")})`;
  return text;
}

/** A problem document (from an answer or inside a statement document) as an error. */
export function problemError(
  problem: ProblemDocument | undefined,
  context: {
    status?: number;
    requestId?: string | null;
    retryAfterMs?: number;
    statementId?: string | null;
    cancelReason?: string;
  } = {},
): ChargewireError {
  const doc: ProblemDocument = problem ?? {};
  const status = typeof doc.status === "number" && doc.status > 0 ? doc.status : context.status;
  // A problem document without a code does not follow the protocol (§11).
  const code = typeof doc.code === "string" && doc.code !== "" ? doc.code : ErrorCode.clientProtocolError;
  return new ChargewireError({
    code,
    status,
    detail: str(doc.detail),
    title: str(doc.title),
    type: adoptLegacyErrorType(str(doc.type)),
    sqlstate: str(doc.sqlstate),
    requestId: str(doc.request_id) ?? context.requestId ?? undefined,
    reason: str(doc.reason),
    retryAfterMs: context.retryAfterMs,
    statementId: context.statementId ?? undefined,
    cancelReason: str(doc.cancel_reason) ?? context.cancelReason,
    problem,
  });
}

const maxProblemBytes = 1 << 20;

/** Turns an error answer into a ChargewireError, whatever its body is. */
export async function responseError(resp: Response): Promise<ChargewireError> {
  let text = "";
  try {
    text = await resp.text();
  } catch {
    // The body could not be read; the status still says what happened.
  }
  if (text.length > maxProblemBytes) text = text.slice(0, maxProblemBytes);
  const retryAfterMs = parseRetryAfter(resp.headers.get("retry-after"));
  const requestId = resp.headers.get("chargewire-request-id");
  // A statement that failed or was cancelled by the time its submit was answered names itself (§6.1).
  const statementId = resp.headers.get("chargewire-statement-id");
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
    return new ChargewireError({
      code: ErrorCode.clientHttpError,
      status: resp.status,
      detail,
      requestId: requestId ?? undefined,
      retryAfterMs,
      statementId: statementId ?? undefined,
    });
  }
  return problemError(doc, { status: resp.status, requestId, retryAfterMs, statementId });
}

/** Reads a Retry-After: always integer delta-seconds (§2.6; servers never send the HTTP-date form). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed) * 1000;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function invalidArgument(message: string): ChargewireError {
  return new ChargewireError({ code: ErrorCode.clientInvalidArgument, message });
}

export function protocolError(message: string, cause?: unknown): ChargewireError {
  return new ChargewireError({ code: ErrorCode.clientProtocolError, message, cause });
}

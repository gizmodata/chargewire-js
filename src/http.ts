// Licensed under the Apache License, Version 2.0.

import { ErrorCode, WarpSqlError, protocolError, responseError, tokenRenewable } from "./errors.js";
import { endpoint, redact } from "./url.js";

export const mediaTypeJSON = "application/json";
export const mediaTypeArrow = "application/vnd.apache.arrow.stream";

/** Receives the client's diagnostics. Every method is optional. */
export interface Logger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/** How the client gets its access token (§4). */
export type Credentials =
  | { kind: "password"; username: string; password: string }
  | { kind: "subject"; subjectToken: () => Promise<string> }
  | { kind: "provider"; provider: () => Promise<string> }
  | { kind: "static"; token: string }
  | { kind: "certificate" } // the client_certificate grant (§4.4): the TLS client certificate
  // browser sign-in (§4.3): each call runs one, the person signing in again
  | { kind: "browser"; signIn: () => Promise<{ accessToken: string; expiresIn: number | undefined }> };

/** A request body. One held in memory can be sent again; a stream is sent once. */
export interface RequestBody {
  contentType: string;
  bytes?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
}

export function jsonBody(value: unknown): RequestBody {
  return { contentType: mediaTypeJSON, bytes: new TextEncoder().encode(stringifyJSON(value)) };
}

/**
 * JSON.stringify, with numbers written so the server reads exactly the value given (§6.1):
 * a bigint as its exact integer, whatever its size; a Number beyond the safe integers in
 * exponent form, which reads back as the same double (JSON.stringify writes 2 ** 63 as
 * 9223372036854776000, another integer, which a server binds exactly, as that integer).
 */
export function stringifyJSON(value: unknown): string {
  const marks: string[] = [];
  // Placeholders are strings with a NUL and a random tag, so no string value can pass for one.
  const tag = randomTag();
  const text = JSON.stringify(value, (_key, v: unknown) => {
    let exact: string | undefined;
    if (typeof v === "bigint") exact = v.toString();
    else if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) {
      exact = v.toExponential();
    }
    if (exact === undefined) return v;
    marks.push(exact);
    return `\u0000${tag}:${marks.length - 1}\u0000`;
  });
  if (marks.length === 0) return text;
  const placeholder = new RegExp(`"\\\\u0000${tag}:(\\d+)\\\\u0000"`, "g");
  return text.replace(placeholder, (_m, i: string) => marks[Number(i)]!);
}

function randomTag(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function replayable(body: RequestBody | undefined): boolean {
  return body === undefined || body.stream === undefined;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Relative to the base path, e.g. `/v1/sessions`. */
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: RequestBody;
  /**
   * The request may be sent again when its answer is lost or the server asks for a
   * retry: reads, deletes, and writes that carry an Idempotency-Key (§6.7).
   */
  idempotent: boolean;
  /** Another server of the same deployment (a partition's location, §6.2). */
  baseUrl?: URL;
  /** No access token (§3, §4.1). */
  anonymous?: boolean;
  signal?: AbortSignal | undefined;
  /** Called when the request is handed to fetch. */
  onSend?: () => void;
}

export interface HttpClientConfig {
  base: URL;
  fetch: typeof fetch;
  credentials: Credentials;
  maxAttempts: number;
  userAgent?: string | undefined;
  logger: Logger;
  /** fetch's credentials mode (browsers: "include" sends the user's client certificate cross-origin). */
  fetchCredentials?: RequestCredentials | undefined;
}

/** How long before its expiry a token is replaced, at most. */
const renewMarginMs = 2 * 60 * 1000;

/**
 * Speaks HTTP to one server. Shared by every session of a connection; safe to use
 * concurrently. Retries what is safe to retry and keeps the access token fresh.
 */
export class HttpClient {
  readonly base: URL;
  readonly logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #credentials: Credentials;
  readonly #maxAttempts: number;
  readonly #userAgent: string | undefined;
  readonly #fetchCredentials: RequestCredentials | undefined;
  #token: string | undefined;
  #renewAt: number | undefined; // when to replace the token; undefined when its lifetime is unknown
  #renewing: Promise<void> | undefined;

  constructor(config: HttpClientConfig) {
    this.base = config.base;
    this.logger = config.logger;
    this.#fetch = config.fetch;
    this.#credentials = config.credentials;
    this.#maxAttempts = Math.max(1, config.maxAttempts);
    this.#userAgent = config.userAgent;
    this.#fetchCredentials = config.fetchCredentials;
    if (config.credentials.kind === "static") this.#token = config.credentials.token;
  }

  /** The token requests carry now (undefined before the first sign-in). */
  get currentToken(): string | undefined {
    return this.#token;
  }

  /** Whether a refused token can be replaced. */
  get canRenew(): boolean {
    return this.#credentials.kind !== "static";
  }

  /**
   * Sends a request and returns its 2xx answer. An error answer becomes a WarpSqlError.
   *
   * Transport failures and 421/429/502/503/504 answers to idempotent requests are sent
   * again (honouring Retry-After), with backoff. A request refused with `invalid_token` is
   * sent once more with a fresh token (the server refused it before running it), unless
   * the refusal's reason says signing in again cannot help or must not happen on its own
   * (`token_revoked`, `credentials_changed`, `principal_dropped`, §4.2): that refusal is
   * the error, with its reason.
   */
  async request(req: HttpRequest): Promise<Response> {
    let backoff = 200;
    const nextBackoff = (): number => {
      const wait = backoff * (0.75 + Math.random() * 0.5);
      backoff = Math.min(backoff * 2, 5000);
      return wait;
    };
    let renewed = false;
    for (let attempt = 1; ; attempt++) {
      const token = req.anonymous ? undefined : await this.accessToken();
      const canRepeat = replayable(req.body) && attempt < this.#maxAttempts;
      let resp: Response;
      try {
        resp = await this.#send(req, token);
      } catch (err) {
        if (req.signal?.aborted) throw abortError(req.signal);
        if (!req.idempotent || !canRepeat || permanentTransportError(err)) {
          throw transportError(req, err);
        }
        this.logger.debug?.("retrying after a transport error", { path: req.path, attempt, error: String(err) });
        await sleep(nextBackoff(), req.signal);
        continue;
      }
      if (resp.status >= 200 && resp.status < 300) return resp;
      const problem = await responseError(resp);
      if (
        problem.code === ErrorCode.invalidToken &&
        tokenRenewable(problem.reason) &&
        !renewed &&
        !req.anonymous &&
        this.canRenew &&
        replayable(req.body)
      ) {
        renewed = true;
        await this.renewToken(token);
        attempt--;
        continue;
      }
      if (req.idempotent && canRepeat && retryableStatus(resp.status)) {
        const wait = problem.retryAfterMs ?? nextBackoff();
        this.logger.debug?.("retrying", { path: req.path, attempt, status: resp.status, code: problem.code, wait });
        await sleep(wait, req.signal);
        continue;
      }
      throw problem;
    }
  }

  async #send(req: HttpRequest, token: string | undefined): Promise<Response> {
    const url = endpoint(req.baseUrl ?? this.base, req.path, req.query);
    const headers = new Headers(req.headers);
    if (req.body) headers.set("Content-Type", req.body.contentType);
    if (!headers.has("Accept")) headers.set("Accept", mediaTypeJSON);
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
    if (this.#userAgent !== undefined) headers.set("User-Agent", this.#userAgent);
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
    if (this.#fetchCredentials !== undefined) init.credentials = this.#fetchCredentials;
    if (req.body?.bytes !== undefined) init.body = req.body.bytes as BodyInit;
    if (req.body?.stream !== undefined) {
      init.body = req.body.stream;
      init.duplex = "half";
    }
    if (req.signal) init.signal = req.signal;
    const start = Date.now();
    req.onSend?.();
    const resp = await this.#fetch.call(globalThis, url, init);
    this.logger.debug?.("warp request", {
      method: req.method,
      path: req.path,
      status: resp.status,
      requestId: resp.headers.get("warp-request-id"),
      ms: Date.now() - start,
    });
    return resp;
  }

  /** Sends a request and decodes its JSON answer. */
  async json<T>(req: HttpRequest): Promise<T> {
    const resp = await this.request(req);
    return decodeJSON<T>(resp, req);
  }

  /** Sends a request and discards its answer. */
  async void(req: HttpRequest): Promise<void> {
    const resp = await this.request(req);
    await discard(resp);
  }

  /** Obtains a token now, so wrong credentials fail at connect time. */
  async authenticate(): Promise<void> {
    if (this.canRenew) await this.renewToken(undefined);
  }

  /** A token to send, renewed first when it is about to expire. */
  async accessToken(): Promise<string | undefined> {
    if (this.#fresh()) return this.#token;
    if (!this.canRenew) return this.#token; // issued elsewhere: send it, the server decides
    await this.renewToken(this.#token);
    return this.#token;
  }

  #fresh(): boolean {
    return this.#token !== undefined && (this.#renewAt === undefined || Date.now() < this.#renewAt);
  }

  /** Replaces `stale` with a new token, unless another caller already did. */
  async renewToken(stale: string | undefined): Promise<void> {
    if (this.#token !== stale && this.#fresh()) return;
    if (this.#renewing === undefined) {
      this.#renewing = this.#obtain().finally(() => {
        this.#renewing = undefined;
      });
    }
    await this.#renewing;
  }

  async #obtain(): Promise<void> {
    const credentials = this.#credentials;
    if (credentials.kind === "static") return;
    if (credentials.kind === "provider") {
      const token = await credentials.provider();
      if (typeof token !== "string" || token === "") throw protocolError("tokenProvider returned no token");
      this.#token = token;
      this.#renewAt = undefined;
      return;
    }
    if (credentials.kind === "browser") {
      const { accessToken, expiresIn } = await credentials.signIn();
      this.#setToken(accessToken, expiresIn);
      return;
    }
    const grant =
      credentials.kind === "password"
        ? { grant_type: "password", username: credentials.username, password: credentials.password }
        : credentials.kind === "certificate"
          ? { grant_type: "client_certificate" } // no fields: the connection's certificate is the credential
          : { grant_type: "token_exchange", subject_token: await credentials.subjectToken() };
    const answer = await this.json<{ access_token?: unknown; token_type?: unknown; expires_in?: unknown }>({
      method: "POST",
      path: "/v1/auth/token",
      body: jsonBody(grant),
      idempotent: true,
      anonymous: true,
    });
    if (
      typeof answer.access_token !== "string" ||
      answer.access_token === "" ||
      typeof answer.token_type !== "string" ||
      answer.token_type.toLowerCase() !== "bearer"
    ) {
      throw protocolError("the token endpoint did not return a bearer token");
    }
    this.#setToken(answer.access_token, typeof answer.expires_in === "number" ? answer.expires_in : undefined);
  }

  #setToken(token: string, expiresIn: number | undefined): void {
    this.#token = token;
    this.#renewAt = undefined;
    if (expiresIn !== undefined && expiresIn > 0) {
      const lifetime = expiresIn * 1000;
      this.#renewAt = Date.now() + lifetime - Math.min(renewMarginMs, lifetime / 4);
    }
  }
}

/** An answer that a repeat of the same request may not get. */
function retryableStatus(status: number): boolean {
  return status === 421 || status === 429 || status === 502 || status === 503 || status === 504;
}

/** A transport failure that sending again cannot cure: the TLS handshake failed on a certificate. */
function permanentTransportError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The TLS alert a server refused the handshake with, when it is one of §4.4's: with TLS 1.3
 * a refused client certificate reaches the client as an alert on its first read, and stands
 * for the refusal, not for a server the client could not reach.
 */
function certificateAlert(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    const text = `${typeof code === "string" ? code : ""} ${e instanceof Error ? e.message : ""}`.toUpperCase();
    if (/ALERT[_ ]CERTIFICATE[_ ]REQUIRED/.test(text)) return ErrorCode.certificateRequired;
    if (/ALERT[_ ]CERTIFICATE[_ ]REVOKED/.test(text)) return ErrorCode.certificateRevoked;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function transportError(req: HttpRequest, err: unknown): WarpSqlError {
  const base = req.baseUrl ?? undefined;
  let reason = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && !reason.includes(cause.message)) reason += `: ${cause.message}`;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && !reason.includes(code)) reason += ` (${code})`;
  const alert = certificateAlert(err);
  return new WarpSqlError({
    code: alert ?? ErrorCode.clientTransportError,
    message:
      `${req.method} ${req.path}${base ? ` on ${redact(base.href)}` : ""}: ` +
      (alert !== undefined ? `the server refused the TLS client certificate (${reason})` : reason),
    cause: err,
  });
}

/** The error for an operation its AbortSignal stopped. */
export function abortError(signal: AbortSignal, statementId?: string): WarpSqlError {
  const reason: unknown = signal.reason;
  if (reason instanceof WarpSqlError) return reason;
  const timeout = reason instanceof Error && reason.name === "TimeoutError";
  return new WarpSqlError({
    code: timeout ? ErrorCode.statementTimeout : ErrorCode.statementCancelled,
    message: timeout
      ? "the operation timed out (its AbortSignal fired)"
      : "the operation was cancelled (its AbortSignal fired)",
    cancelReason: "client",
    statementId,
    cause: reason,
  });
}

export async function decodeJSON<T>(resp: Response, req?: HttpRequest): Promise<T> {
  let text: string;
  try {
    text = await resp.text();
  } catch (err) {
    if (req?.signal?.aborted) throw abortError(req.signal);
    throw new WarpSqlError({
      code: ErrorCode.clientTransportError,
      message: `reading the answer to ${req?.method ?? ""} ${req?.path ?? ""}`,
      cause: err,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw protocolError(`the answer to ${req?.method ?? "a request"} ${req?.path ?? ""} is not JSON`, err);
  }
}

export async function discard(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // Nothing to read.
  }
}

/** Waits, or rejects when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A fresh Idempotency-Key for one logical request (§6.7). */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "k_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

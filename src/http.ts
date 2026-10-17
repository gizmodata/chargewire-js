// Licensed under the Apache License, Version 2.0.

import { ErrorCode, WarpSqlError, protocolError, responseError } from "./errors.js";
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
  | { kind: "static"; token: string };

/** A request body. One held in memory can be sent again; a stream is sent once. */
export interface RequestBody {
  contentType: string;
  bytes?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
}

export function jsonBody(value: unknown): RequestBody {
  return { contentType: mediaTypeJSON, bytes: new TextEncoder().encode(stringifyJSON(value)) };
}

/** JSON.stringify, with bigints written as exact integers. */
export function stringifyJSON(value: unknown): string {
  const marks: string[] = [];
  const text = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") {
      marks.push(v.toString());
      return `\u0000bigint${marks.length - 1}\u0000`;
    }
    return v;
  });
  return marks.length === 0 ? text : text.replace(/"\\u0000bigint(\d+)\\u0000"/g, (_m, i: string) => marks[Number(i)]!);
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
    if (config.credentials.kind === "static") this.#token = config.credentials.token;
  }

  /** Whether a refused token can be replaced. */
  get canRenew(): boolean {
    return this.#credentials.kind !== "static";
  }

  /**
   * Sends a request and returns its 2xx answer. An error answer becomes a WarpSqlError.
   *
   * Transport failures and 421/429/502/503/504 answers to idempotent requests are sent
   * again (honouring Retry-After), with backoff. A request refused for an expired token
   * is sent once more with a fresh token: the server refused it before running it.
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
    const grant =
      credentials.kind === "password"
        ? { grant_type: "password", username: credentials.username, password: credentials.password }
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
    this.#token = answer.access_token;
    this.#renewAt = undefined;
    if (typeof answer.expires_in === "number" && answer.expires_in > 0) {
      const lifetime = answer.expires_in * 1000;
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

function transportError(req: HttpRequest, err: unknown): WarpSqlError {
  const base = req.baseUrl ?? undefined;
  let reason = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && !reason.includes(cause.message)) reason += `: ${cause.message}`;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && !reason.includes(code)) reason += ` (${code})`;
  return new WarpSqlError({
    code: ErrorCode.transportError,
    message: `${req.method} ${req.path}${base ? ` on ${redact(base.href)}` : ""}: ${reason}`,
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
      code: ErrorCode.transportError,
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

// Licensed under the Apache License, Version 2.0.

// Browser sign-in (spec §4.3, capability oauth_browser): the server is the identity
// provider's client; this side creates a flow, has the person open its authorize URL, and
// collects the server's own access token once with the flow's poll secret. The poll secret
// and the token are never logged and never put in a URL.

import { ErrorCode, ChargewireError, invalidArgument, protocolError } from "./errors.js";
import { HttpClient, type Logger, jsonBody, sleep } from "./http.js";
import { legacyBrowserSignInFragmentKey } from "./legacy-names.js";
import { platform } from "#platform";
import type { TlsOptions } from "./platform/types.js";
import type { DiscoveryDocument } from "./protocol.js";
import { type SchemeMap, defaultSchemes, parseUrl } from "./url.js";

/** The URL fragment key a `returnTo` redirect carries the flow id in (§4.3.3). */
export const browserSignInFragmentKey = "chargewire_oauth_flow";

/** A browser sign-in flow (§4.3.1). `pollSecret` collects the token: keep it to yourself. */
export interface BrowserSignInFlow {
  flowId: string;
  pollSecret: string;
  /** Where the person signs in, with the identity provider. */
  authorizeUrl: string;
  /** Seconds between polls. */
  pollIntervalS: number;
  /** When the server forgets the flow (RFC 3339). */
  expiresAt: string;
}

/**
 * A poll's answer: still waiting, or the token (handed out once). A failed sign-in throws.
 * A state a later version adds is never terminal (§12), so it reads as `pending`.
 */
export type BrowserSignInPoll =
  { state: "pending" } | { state: "complete"; accessToken: string; expiresIn: number | undefined };

/** The token a completed browser sign-in gives. */
export interface BrowserSignInResult {
  accessToken: string;
  /** Seconds the token lives, when the server says. */
  expiresIn: number | undefined;
}

/** Which server to sign in to, and how to reach it. */
export interface BrowserSignInTarget {
  /** As `connect`'s url: `chargewire://host:port`, `https://…`, `http://…`. */
  url: string;
  schemes?: SchemeMap;
  /** The fetch to use (default: the global one). */
  fetch?: typeof fetch;
  /** TLS settings (Node, Deno, Bun). */
  tls?: TlsOptions;
  fetchCredentials?: RequestCredentials;
  userAgent?: string;
  logger?: Logger;
  signal?: AbortSignal;
}

/** The identity provider's name a server gives for browser sign-in ("Okta"), if any (§4.3). */
export function browserSignInProvider(discovery: DiscoveryDocument): string | undefined {
  const name = discovery.auth?.oauth_browser?.provider;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * Servers (base URLs) found to be from before the protocol's rename, so that each later call
 * of a sign-in (every poll) speaks their spelling at once instead of finding it again.
 */
const legacyServers = new Set<string>();
const maxLegacyServers = 64;

function noteServer(requested: URL, http: HttpClient): void {
  if (!http.legacy || legacyServers.has(requested.href)) return;
  if (legacyServers.size >= maxLegacyServers) legacyServers.delete(legacyServers.values().next().value!);
  legacyServers.add(requested.href);
}

async function clientFor(target: BrowserSignInTarget): Promise<{ http: HttpClient; base: URL }> {
  if (target === null || typeof target !== "object") throw invalidArgument("browser sign-in takes an options object");
  if (target.tls !== undefined && target.fetch !== undefined) {
    throw invalidArgument("pass either tls or fetch: tls settings cannot be applied to a fetch of your own");
  }
  const base = parseUrl(target.url, target.schemes ?? defaultSchemes);
  const fetchFn =
    target.fetch ??
    (target.tls !== undefined ? await platform.tlsFetch(target.tls) : globalThis.fetch.bind<typeof fetch>(globalThis));
  const http = new HttpClient({
    base,
    legacy: legacyServers.has(base.href),
    fetch: fetchFn,
    credentials: { kind: "static", token: "" },
    // Neither request may be repeated blindly: a flow is created anew, and a token is handed out once.
    maxAttempts: 1,
    userAgent: target.userAgent,
    logger: { debug: target.logger?.debug?.bind(target.logger), warn: target.logger?.warn?.bind(target.logger) },
    fetchCredentials: target.fetchCredentials,
  });
  return { http, base };
}

/**
 * Creates a flow (§4.3.1). `returnTo` (clients in a browser, §4.3.3) is a path on the
 * server's own origin the browser is sent back to, with the flow id in the URL fragment.
 */
export async function startBrowserSignIn(
  options: BrowserSignInTarget & { returnTo?: string },
): Promise<BrowserSignInFlow> {
  const { http, base } = await clientFor(options);
  if (options.returnTo !== undefined && (typeof options.returnTo !== "string" || !options.returnTo.startsWith("/"))) {
    throw invalidArgument("returnTo must be a path on the server's own origin, starting with /");
  }
  const answer = await http.json<Record<string, unknown>>({
    method: "POST",
    path: "/v1/auth/oauth/flows",
    body: jsonBody(options.returnTo !== undefined ? { return_to: options.returnTo } : {}),
    idempotent: false,
    anonymous: true,
    signal: options.signal,
  });
  noteServer(base, http);
  const flow = {
    flowId: answer["flow_id"],
    pollSecret: answer["poll_secret"],
    authorizeUrl: answer["authorize_url"],
    pollIntervalS: answer["poll_interval_s"],
    expiresAt: answer["expires_at"],
  };
  if (
    typeof flow.flowId !== "string" ||
    flow.flowId === "" ||
    typeof flow.pollSecret !== "string" ||
    flow.pollSecret === "" ||
    typeof flow.authorizeUrl !== "string" ||
    flow.authorizeUrl === ""
  ) {
    throw protocolError("the browser sign-in answer lacks flow_id, poll_secret or authorize_url");
  }
  return {
    flowId: flow.flowId,
    pollSecret: flow.pollSecret,
    authorizeUrl: flow.authorizeUrl,
    pollIntervalS: typeof flow.pollIntervalS === "number" && flow.pollIntervalS > 0 ? flow.pollIntervalS : 2,
    expiresAt: typeof flow.expiresAt === "string" ? flow.expiresAt : "",
  };
}

/**
 * Polls a flow once (§4.3.2). A failed sign-in throws a ChargewireError whose code is the
 * flow's `error.code` (`access_denied`, `invalid_credentials`, `identity_provider_error`, or
 * one a later version adds, kept as sent: a generic failure, §12), with no `status`: the
 * poll itself succeeded. A flow that expired, was already collected or is given the wrong
 * secret is `flow_not_found`. A state the client doesn't know is not terminal: `pending`.
 */
export async function pollBrowserSignIn(
  options: BrowserSignInTarget & { flow: Pick<BrowserSignInFlow, "flowId" | "pollSecret"> },
): Promise<BrowserSignInPoll> {
  const { flowId, pollSecret } = options.flow ?? {};
  if (typeof flowId !== "string" || !/^[A-Za-z0-9._~-]+$/.test(flowId) || typeof pollSecret !== "string") {
    throw invalidArgument("flow needs the flowId and pollSecret startBrowserSignIn returned");
  }
  const { http, base } = await clientFor(options);
  const answer = await http.json<Record<string, unknown>>({
    method: "POST",
    path: `/v1/auth/oauth/flows/${flowId}`,
    body: jsonBody({ poll_secret: pollSecret }),
    idempotent: false,
    anonymous: true,
    signal: options.signal,
  });
  noteServer(base, http);
  switch (answer["state"]) {
    case "pending":
      return { state: "pending" };
    case "complete": {
      const token = answer["access_token"];
      const type = answer["token_type"];
      if (typeof token !== "string" || token === "" || typeof type !== "string" || type.toLowerCase() !== "bearer") {
        throw protocolError("the completed browser sign-in has no bearer token");
      }
      const expiresIn = answer["expires_in"];
      return {
        state: "complete",
        accessToken: token,
        expiresIn: typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : undefined,
      };
    }
    case "failed": {
      const error = (answer["error"] ?? {}) as { code?: unknown; detail?: unknown };
      const detail = typeof error.detail === "string" ? error.detail : undefined;
      if (typeof error.code !== "string" || error.code === "") {
        throw protocolError(`the browser sign-in failed without an error code${detail ? `: ${detail}` : ""}`);
      }
      const code = error.code;
      throw new ChargewireError({ code, detail, message: `browser sign-in failed: ${detail || code} (${code})` });
    }
  }
  if (typeof answer["state"] !== "string") throw protocolError("the browser sign-in poll answer has no state");
  // A state a later version adds is not terminal (§12): keep polling.
  return { state: "pending" };
}

/**
 * The whole browser sign-in, for clients outside a browser page (Node tools, desktop
 * apps): creates a flow, hands its authorize URL to `openUrl` (open a browser, or show the
 * URL), and polls at the server's interval until the person has signed in, for at most
 * `timeoutMs` (default 5 minutes; `client_sign_in_timeout` after it).
 */
export async function browserSignIn(
  options: BrowserSignInTarget & { openUrl: (url: string) => void | Promise<void>; timeoutMs?: number },
): Promise<BrowserSignInResult> {
  if (typeof options?.openUrl !== "function") {
    throw invalidArgument("browser sign-in needs openUrl, a function that opens (or shows) the sign-in URL");
  }
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw invalidArgument("timeoutMs must be a positive number");
  const flow = await startBrowserSignIn(options);
  await options.openUrl(flow.authorizeUrl);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const poll = await pollBrowserSignIn({ ...options, flow });
    if (poll.state === "complete") return { accessToken: poll.accessToken, expiresIn: poll.expiresIn };
    if (Date.now() >= deadline) {
      throw new ChargewireError({
        code: ErrorCode.clientSignInTimeout,
        message: `the browser sign-in was not completed within ${Math.round(timeoutMs / 1000)} s`,
      });
    }
    await sleep(Math.min(flow.pollIntervalS * 1000, Math.max(0, deadline - Date.now())), options.signal);
  }
}

/**
 * The flow id a `returnTo` redirect put in `url`'s fragment (§4.3.3), and the URL without
 * it (other fragment content kept). Undefined when there is none.
 */
export function takeBrowserSignInFlowId(url: string | URL): { flowId: string; url: string } | undefined {
  const parsed = new URL(typeof url === "string" ? url : url.href);
  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (fragment === "") return undefined;
  const params = new URLSearchParams(fragment);
  // A server from before the protocol's rename names the key in its own spelling.
  const key = params.has(browserSignInFragmentKey) ? browserSignInFragmentKey : legacyBrowserSignInFragmentKey;
  const flowId = params.get(key);
  if (flowId === null || !/^[A-Za-z0-9._~-]{1,128}$/.test(flowId)) return undefined;
  params.delete(key);
  const rest = params.toString();
  parsed.hash = rest === "" ? "" : `#${rest}`;
  return { flowId, url: parsed.href };
}

/** Where a page keeps its pending flows' secrets between leaving and coming back. */
export interface BrowserSignInStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const storageKey = (flowId: string): string => `chargewire:browser-sign-in:${flowId}`;

function pageStorage(given: BrowserSignInStorage | undefined): BrowserSignInStorage {
  if (given !== undefined) return given;
  const storage = (globalThis as { sessionStorage?: BrowserSignInStorage }).sessionStorage;
  if (storage === undefined) throw invalidArgument("no sessionStorage here: pass storage");
  return storage;
}

/**
 * For a page: starts a flow that returns to `returnTo` (default: this page's path and
 * query), keeps its poll secret in `storage` (default sessionStorage, this tab only), and
 * sends the browser to the identity provider (`assign`, default location.assign).
 * {@link completeBrowserRedirectSignIn} picks it up when the browser comes back.
 */
export async function beginBrowserRedirectSignIn(
  options: BrowserSignInTarget & {
    returnTo?: string;
    storage?: BrowserSignInStorage;
    assign?: (url: string) => void;
  },
): Promise<void> {
  const location = (globalThis as { location?: Location }).location;
  const returnTo = options.returnTo ?? (location ? location.pathname + location.search : undefined);
  if (returnTo === undefined) throw invalidArgument("returnTo is required outside a browser page");
  const storage = pageStorage(options.storage);
  const flow = await startBrowserSignIn({ ...options, returnTo });
  storage.setItem(storageKey(flow.flowId), JSON.stringify({ pollSecret: flow.pollSecret, expiresAt: flow.expiresAt }));
  const assign = options.assign ?? ((url: string) => location!.assign(url));
  assign(flow.authorizeUrl);
}

/**
 * For a page the identity provider's sign-in returned to: reads the flow id from the
 * fragment of `href` (default location.href), removes it from the address bar
 * (`replaceUrl`, default history.replaceState), and collects the token with the secret
 * {@link beginBrowserRedirectSignIn} kept. Undefined when the page carries no flow id, or
 * one this tab did not start (which it must ignore, §4.3.3). A failed sign-in throws.
 */
export async function completeBrowserRedirectSignIn(
  options: BrowserSignInTarget & {
    href?: string;
    storage?: BrowserSignInStorage;
    replaceUrl?: (url: string) => void;
  },
): Promise<BrowserSignInResult | undefined> {
  const href = options.href ?? (globalThis as { location?: Location }).location?.href;
  if (href === undefined) throw invalidArgument("href is required outside a browser page");
  const taken = takeBrowserSignInFlowId(href);
  if (taken === undefined) return undefined;
  const replace =
    options.replaceUrl ?? ((url: string) => (globalThis as { history?: History }).history?.replaceState(null, "", url));
  replace(taken.url);
  const storage = pageStorage(options.storage);
  const key = storageKey(taken.flowId);
  const saved = storage.getItem(key);
  storage.removeItem(key);
  if (saved === null) return undefined;
  let pollSecret: unknown;
  try {
    pollSecret = (JSON.parse(saved) as { pollSecret?: unknown }).pollSecret;
  } catch {
    return undefined;
  }
  if (typeof pollSecret !== "string" || pollSecret === "") return undefined;
  // The server finished the sign-in before it redirected, so the first poll normally has
  // the outcome; a few more cover a server that answers the redirect first.
  for (let attempt = 0; ; attempt++) {
    const poll = await pollBrowserSignIn({ ...options, flow: { flowId: taken.flowId, pollSecret } });
    if (poll.state === "complete") return { accessToken: poll.accessToken, expiresIn: poll.expiresIn };
    if (attempt >= 30) {
      throw new ChargewireError({
        code: ErrorCode.clientSignInTimeout,
        message: "the browser sign-in did not complete",
      });
    }
    await sleep(1000, options.signal);
  }
}

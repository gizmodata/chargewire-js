// Licensed under the Apache License, Version 2.0.
//
// Connection strings saved before the protocol was renamed to Chargewire keep working: the
// old scheme (`warp://`) means `chargewire://`, and the old default base path (`/warp`) means
// `/chargewire`. The mapping is silent. This module and its tests are the only places the old
// spelling is written down.

import type { SchemeMap } from "./url.js";

const legacyScheme = "warp";
const currentScheme = "chargewire";
const legacyBasePath = "/warp";

/**
 * Rewrites a URL's old scheme to the current one, when the accepted schemes have the current
 * scheme and don't define the old one themselves. Anything else comes back unchanged.
 */
export function adoptLegacyScheme(raw: string, schemes: SchemeMap): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (match === null || match[1]!.toLowerCase() !== legacyScheme) return raw;
  if (Object.hasOwn(schemes, legacyScheme) || !Object.hasOwn(schemes, currentScheme)) return raw;
  return `${currentScheme}://${raw.slice(match[0].length)}`;
}

/**
 * The base path to use for a URL's path (trailing slashes already removed): the old default
 * base path becomes `current`, the current default; any other path is kept.
 */
export function adoptLegacyBasePath(path: string, current: string): string {
  return path === legacyBasePath ? current : path;
}

// Servers from before the rename speak the protocol in the old spelling: a client that finds
// nothing at the current default base path but a pre-rename server at the old one talks to it
// in that spelling for the rest of the connection (see HttpClient).

const legacyProtocol = "warp-sql";
const currentProtocol = "chargewire";
const legacyHeaderPrefix = "warp-";
const currentHeaderPrefix = "chargewire-";
const legacyErrorTypePrefix = "urn:warp-sql:error:";
const currentErrorTypePrefix = "urn:chargewire:error:";

/** The table-schema metadata key a pre-rename server puts a column's default in. */
export const legacyColumnDefaultKey = "WARP:SQL:COLUMN_DEFAULT";

/** The URL fragment key a pre-rename server's `returnTo` redirect carries the flow id in. */
export const legacyBrowserSignInFragmentKey = "warp_oauth_flow";

/** The base URL a pre-rename server mounts the protocol at, next to `base` (the current default). */
export function legacyBase(base: URL): URL {
  const url = new URL(base.href);
  url.pathname = legacyBasePath;
  return url;
}

/**
 * When `doc` is a pre-rename server's discovery document, the same document with the
 * protocol named as it is now; otherwise undefined.
 */
export function adoptLegacyDiscovery<T extends { protocol?: unknown }>(doc: T): T | undefined {
  if (doc === null || typeof doc !== "object" || doc.protocol !== legacyProtocol) return undefined;
  return { ...doc, protocol: currentProtocol };
}

/** A request's protocol headers in the pre-rename spelling (other headers as they are). */
export function legacyRequestHeaders(headers: Headers): Headers {
  return renameHeaders(headers, currentHeaderPrefix, legacyHeaderPrefix);
}

/** A pre-rename server's answer with its protocol headers in the current spelling; the body is passed through. */
export function adoptLegacyResponse(resp: Response): Response {
  const headers = renameHeaders(resp.headers, legacyHeaderPrefix, currentHeaderPrefix);
  // Statuses that never carry a body (a Response with one refuses a body, even an empty stream).
  const body = [101, 103, 204, 205, 304].includes(resp.status) ? null : resp.body;
  const out = new Response(body, { status: resp.status, statusText: resp.statusText, headers });
  if (resp.url !== "") Object.defineProperty(out, "url", { value: resp.url });
  return out;
}

/** A problem document's `type` in the current spelling (a pre-rename server's prefix replaced). */
export function adoptLegacyErrorType(type: string | undefined): string | undefined {
  return type?.startsWith(legacyErrorTypePrefix)
    ? currentErrorTypePrefix + type.slice(legacyErrorTypePrefix.length)
    : type;
}

function renameHeaders(headers: Headers, from: string, to: string): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    // Headers iterate with lower-case names; a repeated header comes joined, as it would be read.
    out.set(name.startsWith(from) ? to + name.slice(from.length) : name, value);
  });
  return out;
}

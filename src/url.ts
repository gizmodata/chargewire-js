// Licensed under the Apache License, Version 2.0.

import { invalidArgument } from "./errors.js";

/** What a URL scheme means: whether it is TLS by default, and its default port and base path. */
export interface SchemeDefinition {
  /** TLS unless the URL says `?tls=false`. */
  tls: boolean;
  /** Whether `?tls=false` may turn TLS off (true for `warp://`). */
  tlsParameter?: boolean;
  /** The port when the URL has none (default: 443 for TLS, 80 otherwise). */
  defaultPort?: number;
  /** The protocol's base path when the URL has none (default `/warp`, §2.1). */
  defaultBasePath?: string;
}

/** Scheme name (lower case, without `://`) to its meaning. */
export type SchemeMap = Readonly<Record<string, SchemeDefinition>>;

/**
 * The schemes `connect` accepts. A branded wrapper adds its own:
 *
 * ```ts
 * connect({ ...options, schemes: { ...defaultSchemes, hardcharger: { tls: true, tlsParameter: true, defaultPort: 31337 } } })
 * ```
 */
export const defaultSchemes: SchemeMap = Object.freeze({
  warp: { tls: true, tlsParameter: true },
  https: { tls: true },
  http: { tls: false },
});

/** The protocol's base path when a URL names none (§2.1). */
export const defaultBasePath = "/warp";

/**
 * Parses a connection URL into the protocol's base URL (e.g. `https://db.example.com:31337/warp`).
 *
 *     warp://host:port                  HTTPS, base path /warp
 *     warp://host:port/custom/prefix    HTTPS, base path /custom/prefix
 *     warp://host:port?tls=false        plain HTTP (development, loopback)
 *     https://host:port[/prefix]        same as warp://
 *     http://host:port[/prefix]         plain HTTP
 *
 * Credentials never belong in a URL; one with user info is refused.
 */
export function parseUrl(raw: string, schemes: SchemeMap = defaultSchemes): URL {
  if (typeof raw !== "string" || raw === "") {
    throw invalidArgument("a url is required, e.g. warp://host:port");
  }
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (!match) throw invalidArgument(`invalid url ${redact(raw)}: it needs a scheme, e.g. warp://host:port`);
  const scheme = match[1]!.toLowerCase();
  const definition = Object.hasOwn(schemes, scheme) ? schemes[scheme] : undefined;
  if (definition === undefined) {
    const names = Object.keys(schemes)
      .map((name) => `${name}://`)
      .join(", ");
    throw invalidArgument(`invalid url ${redact(raw)}: the scheme must be one of ${names}`);
  }
  // Parse as https so that host, port and path follow the WHATWG rules for special
  // schemes whatever the scheme is called.
  let url: URL;
  try {
    url = new URL("https://" + raw.slice(match[0].length));
  } catch {
    throw invalidArgument(`invalid url ${redact(raw)}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidArgument(
      `invalid url ${redact(raw)}: credentials do not belong in the url; use the username and password options`,
    );
  }
  if (url.hostname === "") throw invalidArgument(`invalid url ${redact(raw)}: no host`);

  let tls = definition.tls;
  const params = url.searchParams;
  if (definition.tlsParameter && params.has("tls")) {
    const value = params.get("tls")!.toLowerCase();
    if (value === "true" || value === "1") tls = true;
    else if (value === "false" || value === "0") tls = false;
    else throw invalidArgument(`invalid url ${redact(raw)}: tls must be true or false, not ${JSON.stringify(value)}`);
    params.delete("tls");
  }
  const unknown = [...new Set(params.keys())].sort();
  if (unknown.length > 0) {
    throw invalidArgument(`invalid url ${redact(raw)}: unknown parameter(s) ${unknown.join(", ")}`);
  }

  // The URL is parsed as https, which drops a port of 443 as https's default: take an explicit
  // port from the text, so warp://host:443?tls=false and http://host:443 dial 443 (not 80), and
  // a wrapper's scheme with a default port of its own keeps an explicit :443.
  const explicit = explicitPort(raw.slice(match[0].length));
  const port =
    explicit ??
    (url.port !== "" ? url.port : definition.defaultPort !== undefined ? String(definition.defaultPort) : "");
  const path = url.pathname.replace(/\/+$/, "");
  const base = new URL(`${tls ? "https" : "http"}://${url.host}`);
  base.port = port;
  base.pathname = path === "" ? (definition.defaultBasePath ?? defaultBasePath) : path;
  return base;
}

/** The port written in a URL's authority (after `scheme://`), or undefined when it names none. */
function explicitPort(rest: string): string | undefined {
  const authority = /^[^/?#]*/.exec(rest)![0];
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const port = /^(?:\[[^\]]*\]|[^:[\]]*):(\d+)$/.exec(hostPort)?.[1];
  return port === undefined ? undefined : String(Number(port));
}

/** The URL without anything secret in it, for error messages. */
export function redact(raw: string): string {
  return raw.replace(/\/\/[^/@?#]*@/, "//***@");
}

/** Joins the base URL and a protocol path (`/v1/sessions`), with query parameters. */
export function endpoint(base: URL, path: string, query?: Readonly<Record<string, string | undefined>>): URL {
  const url = new URL(base.href);
  url.pathname = base.pathname.replace(/\/+$/, "") + path;
  url.search = "";
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }
  return url;
}

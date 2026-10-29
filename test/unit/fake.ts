// An in-process Chargewire server for the behaviours a real server cannot be made to show:
// tokens expiring mid-connection, sessions ended for a reason, partitions on other
// servers, Retry-After. It is a fetch function.

import { type Table, tableToIPC } from "apache-arrow";

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export type Handler = (req: FakeRequest, match: RegExpMatchArray) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const problem = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify({ status, code, detail: `fake ${code}`, ...extra }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });

export const arrow = (table: Table, headers: Record<string, string> = {}): Response =>
  new Response(tableToIPC(table, "stream") as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": "application/vnd.apache.arrow.stream", ...headers },
  });

export class FakeServer {
  readonly requests: FakeRequest[] = [];
  readonly routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  capabilities = ["prepared_statements", "transactions", "ingest", "long_poll"];
  tokens = 0;
  expiresIn: number | undefined = 3600;
  validTokens = new Set<string>();
  sessions = 0;

  constructor() {
    this.on("GET", /^\/chargewire$/, () =>
      json(200, {
        protocol: "chargewire",
        protocol_versions: ["1"],
        capabilities: this.capabilities,
        auth: { grant_types: ["password"] },
      }),
    );
    this.on("POST", /^\/chargewire\/v1\/auth\/token$/, () => {
      const token = `t${++this.tokens}`;
      this.validTokens.add(token);
      return json(200, {
        access_token: token,
        token_type: "Bearer",
        ...(this.expiresIn !== undefined ? { expires_in: this.expiresIn } : {}),
      });
    });
    this.on("POST", /^\/chargewire\/v1\/sessions$/, () =>
      json(201, { session_id: `s${++this.sessions}`, options: {}, transaction: "none", idle_timeout_s: 900 }),
    );
    this.on("DELETE", /^\/chargewire\/v1\/sessions\/[^/]+$/, () => new Response(null, { status: 204 }));
  }

  /** Adds a route; later routes win over earlier ones. */
  on(method: string, pattern: RegExp, handler: Handler): this {
    this.routes.unshift({ method, pattern, handler });
    return this;
  }

  count(method: string, pattern: RegExp): number {
    return this.requests.filter((r) => r.method === method && pattern.test(r.url.pathname)).length;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    let body = "";
    if (init?.body instanceof Uint8Array) body = new TextDecoder().decode(init.body);
    else if (typeof init?.body === "string") body = init.body;
    const req: FakeRequest = { method: init?.method ?? "GET", url, headers, body };
    this.requests.push(req);
    const auth = headers.get("authorization");
    const anonymous =
      url.pathname === "/chargewire" || url.pathname.endsWith("/auth/token") || url.pathname.includes("/auth/oauth/");
    if (!anonymous && (auth === null || !this.validTokens.has(auth.replace(/^Bearer /, "")))) {
      return problem(401, "invalid_token", {}, { "www-authenticate": "Bearer" });
    }
    for (const route of this.routes) {
      const match = route.method === req.method ? url.pathname.match(route.pattern) : null;
      if (match) return route.handler(req, match);
    }
    return problem(404, "not_found");
  };
}

// Licensed under the Apache License, Version 2.0.
//
// A small OpenID Connect provider for the browser sign-in tests (§4.3): discovery, a JWKS,
// an authorization endpoint that approves at once (302 back to the server's callback with
// a code, as a provider does after the person signs in), and a token endpoint that checks
// the client's credentials, single-use codes, the redirect URI and PKCE (S256), and answers
// with an RS256 ID token carrying the request's nonce. `email` and `deny` decide the next
// sign-in.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  email: string;
  deny: boolean;
  stop(): Promise<void>;
}

export async function startIdp(): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "live-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string; email: string }>();
  const idp: MockIdp = {
    issuer: "",
    clientId: "warp-sql-js-live",
    clientSecret: randomBytes(12).toString("base64") + "+/=",
    email: "alice@example.com",
    deny: false,
    stop: async () => {},
  };
  const reply = (res: ServerResponse, status: number, body: unknown, location?: string): void => {
    res.writeHead(status, { "content-type": "application/json", ...(location ? { location } : {}) });
    res.end(JSON.stringify(body));
  };
  const idToken = (email: string, nonce: string): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
    const payload = b64url(
      JSON.stringify({ iss: idp.issuer, aud: idp.clientId, sub: email, email, iat: now, exp: now + 300, nonce }),
    );
    return `${header}.${payload}.${b64url(sign("sha256", Buffer.from(`${header}.${payload}`), privateKey))}`;
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", idp.issuer);
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return reply(res, 200, {
        issuer: idp.issuer,
        jwks_uri: `${idp.issuer}/jwks`,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
      });
    }
    if (req.method === "GET" && url.pathname === "/jwks") return reply(res, 200, { keys: [jwk] });
    if (req.method === "GET" && url.pathname === "/authorize") {
      const q = url.searchParams;
      const redirect = q.get("redirect_uri") ?? "";
      if (q.get("client_id") !== idp.clientId || redirect === "") return reply(res, 400, { error: "invalid_request" });
      const back = new URL(redirect);
      back.searchParams.set("state", q.get("state") ?? "");
      if (idp.deny) {
        back.searchParams.set("error", "access_denied");
        return reply(res, 302, {}, back.href);
      }
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") {
        return reply(res, 400, { error: "invalid_request" });
      }
      const code = randomBytes(12).toString("hex");
      codes.set(code, {
        challenge: q.get("code_challenge") ?? "",
        nonce: q.get("nonce") ?? "",
        redirect,
        email: idp.email,
      });
      back.searchParams.set("code", code);
      return reply(res, 302, {}, back.href);
    }
    if (req.method === "POST" && url.pathname === "/token") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("client_id") !== idp.clientId || form.get("client_secret") !== idp.clientSecret) {
          return reply(res, 401, { error: "invalid_client" });
        }
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (grant === undefined || grant.redirect !== form.get("redirect_uri")) {
          return reply(res, 400, { error: "invalid_grant" });
        }
        const verifier = form.get("code_verifier") ?? "";
        if (b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) {
          return reply(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        reply(res, 200, { access_token: "unused", token_type: "Bearer", id_token: idToken(grant.email, grant.nonce) });
      });
      return;
    }
    reply(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return idp;
}

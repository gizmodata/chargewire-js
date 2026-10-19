import { describe, expect, test } from "vitest";

import { ErrorCode, WarpSqlError, defaultSchemes, parseUrl } from "../../src/index.js";
import { endpoint } from "../../src/url.js";

const refused = (raw: string, schemes = defaultSchemes): WarpSqlError => {
  try {
    parseUrl(raw, schemes);
  } catch (err) {
    expect(err).toBeInstanceOf(WarpSqlError);
    expect((err as WarpSqlError).code).toBe(ErrorCode.clientInvalidArgument);
    return err as WarpSqlError;
  }
  throw new Error(`${raw} was accepted`);
};

describe("parseUrl", () => {
  test.each([
    ["warp://db.example.com:31337", "https://db.example.com:31337/warp"],
    ["warp://db.example.com:31337/custom/prefix/", "https://db.example.com:31337/custom/prefix"],
    ["warp://127.0.0.1:31337?tls=false", "http://127.0.0.1:31337/warp"],
    ["warp://h:1?tls=true", "https://h:1/warp"],
    ["WARP://H:1", "https://h:1/warp"],
    ["https://h", "https://h/warp"],
    ["http://h:8080/warp", "http://h:8080/warp"],
    ["warp://[::1]:9", "https://[::1]:9/warp"],
    // An explicit port that is https's default (443) or http's (80) is kept for the other scheme.
    ["warp://h:443?tls=false", "http://h:443/warp"],
    ["http://h:443", "http://h:443/warp"],
    ["warp://h:80", "https://h:80/warp"],
    ["warp://h:443", "https://h/warp"],
    ["http://h:80", "http://h/warp"],
    ["warp://[::1]:443?tls=false", "http://[::1]:443/warp"],
  ])("%s → %s", (raw, want) => {
    expect(parseUrl(raw).href).toBe(want);
  });

  test("credentials never belong in a URL, and the error does not repeat them", () => {
    const err = refused("warp://joe:s3cret@h:1");
    expect(err.message).not.toContain("s3cret");
    expect(err.message).toContain("credentials do not belong");
  });

  test("unknown schemes, parameters and bad tls values are refused", () => {
    refused("ftp://h:1");
    refused("h:1");
    refused("warp://h:1?x=1");
    refused("warp://h:1?tls=maybe");
    refused("http://h:1?tls=false"); // only warp:// takes tls=
    refused("warp://:1");
    refused("");
  });

  test("a wrapper adds its own scheme with a default port", () => {
    const schemes = { ...defaultSchemes, hardcharger: { tls: true, tlsParameter: true, defaultPort: 31337 } };
    expect(parseUrl("hardcharger://db.example.com", schemes).href).toBe("https://db.example.com:31337/warp");
    expect(parseUrl("hardcharger://db.example.com:1?tls=false", schemes).href).toBe("http://db.example.com:1/warp");
    // An explicit 443 is that port, not "no port" (which would get the wrapper's default).
    expect(parseUrl("hardcharger://db.example.com:443", schemes).href).toBe("https://db.example.com/warp");
    expect(parseUrl("hardcharger://db.example.com:443?tls=false", schemes).href).toBe("http://db.example.com:443/warp");
    expect(parseUrl("hardcharger://db.example.com:", schemes).href).toBe("https://db.example.com:31337/warp");
    refused("hardcharger://db"); // not without the wrapper's map
  });

  test("endpoint joins the base path, the protocol path and the query", () => {
    const base = parseUrl("warp://h:1/x/");
    expect(endpoint(base, "/v1/sessions/a%2Fb", { table: "t", mode: undefined }).href).toBe(
      "https://h:1/x/v1/sessions/a%2Fb?table=t",
    );
    expect(endpoint(base, "").href).toBe("https://h:1/x");
  });
});

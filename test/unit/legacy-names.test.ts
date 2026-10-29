// Connection strings saved before the protocol's rename keep working, silently.

import { afterEach, describe, expect, test, vi } from "vitest";

import { ChargewireError, ErrorCode, defaultSchemes, parseUrl } from "../../src/index.js";
import { adoptLegacyBasePath, adoptLegacyScheme } from "../../src/legacy-names.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connection strings from before the rename", () => {
  test.each([
    ["warp://db.example.com:31337", "https://db.example.com:31337/chargewire"],
    ["WARP://H:1", "https://h:1/chargewire"],
    ["Warp://h:1?tls=true", "https://h:1/chargewire"],
    ["warp://127.0.0.1:31337?tls=false", "http://127.0.0.1:31337/chargewire"],
    ["warp://h:443?tls=false", "http://h:443/chargewire"],
    ["warp://[::1]:9", "https://[::1]:9/chargewire"],
    // The old default base path, written out, is the current one.
    ["warp://h:1/warp", "https://h:1/chargewire"],
    ["warp://h:1/warp/?tls=false", "http://h:1/chargewire"],
    ["https://h:1/warp", "https://h:1/chargewire"],
    ["http://h:8080/warp/", "http://h:8080/chargewire"],
    // A custom prefix is the server's own choice and stays as it is.
    ["warp://h:1/custom/prefix", "https://h:1/custom/prefix"],
    ["warp://h:1/custom/warp", "https://h:1/custom/warp"],
    ["https://h:1/warpdrive", "https://h:1/warpdrive"],
  ])("%s → %s", (raw, want) => {
    expect(parseUrl(raw).href).toBe(want);
  });

  test("the mapping writes nothing to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    parseUrl("warp://h:1/warp?tls=false");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test("the old scheme still follows the current scheme's rules", () => {
    for (const raw of ["warp://h:1?tls=maybe", "warp://h:1?color=blue", "warp://:1", "warp://joe:s3cret@h:1"]) {
      let caught: unknown;
      try {
        parseUrl(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught, raw).toBeInstanceOf(ChargewireError);
      expect((caught as ChargewireError).code).toBe(ErrorCode.clientInvalidArgument);
      expect((caught as ChargewireError).message).not.toContain("s3cret");
    }
  });

  test("a wrapper's schemes decide: no current scheme, no mapping; its own old scheme wins", () => {
    const branded = { hardcharger: { tls: true, tlsParameter: true, defaultPort: 31337 } };
    expect(() => parseUrl("warp://h:1", branded)).toThrow(/the scheme must be one of hardcharger:\/\//);
    const own = { ...defaultSchemes, warp: { tls: false, defaultPort: 7 } };
    expect(parseUrl("warp://h", own).href).toBe("http://h:7/chargewire");
    // A wrapper's scheme with the old default base path written out reaches the current one.
    expect(parseUrl("hardcharger://h/warp", { ...defaultSchemes, ...branded }).href).toBe("https://h:31337/chargewire");
  });

  test("the helpers leave everything else alone", () => {
    expect(adoptLegacyScheme("chargewire://h:1", defaultSchemes)).toBe("chargewire://h:1");
    expect(adoptLegacyScheme("https://warp:1", defaultSchemes)).toBe("https://warp:1");
    expect(adoptLegacyScheme("warpx://h:1", defaultSchemes)).toBe("warpx://h:1");
    expect(adoptLegacyScheme("warp:/h", defaultSchemes)).toBe("warp:/h");
    expect(adoptLegacyScheme("warp://h:1/warp", defaultSchemes)).toBe("chargewire://h:1/warp");
    expect(adoptLegacyBasePath("/warp", "/chargewire")).toBe("/chargewire");
    expect(adoptLegacyBasePath("/WARP", "/chargewire")).toBe("/WARP");
    expect(adoptLegacyBasePath("", "/chargewire")).toBe("");
    expect(adoptLegacyBasePath("/x/warp", "/chargewire")).toBe("/x/warp");
  });
});

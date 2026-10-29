// Licensed under the Apache License, Version 2.0.
//
// A connection string saved before the protocol's rename still connects and queries.

import { describe, expect, test } from "vitest";

import { connect } from "../../src/index.js";
import { testUsername } from "./harness.js";
import { quiet, reached, scalar, shared } from "./helpers.js";

describe("connection strings from before the rename", () => {
  test.each([`warp://${shared.host}?tls=false`, `warp://${shared.host}/warp?tls=false`, `http://${shared.host}/warp`])(
    "%s connects and runs a query",
    async (url) => {
      reached();
      const conn = await connect({ url, username: testUsername, password: shared.password, logger: quiet });
      try {
        expect(conn.server.protocol).toBe("chargewire");
        expect(await scalar(conn, "SELECT 41 + 1")).toBe(42);
      } finally {
        await conn.close();
      }
    },
  );
});

import { readFileSync } from "node:fs";

import { tableFromArrays } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { type Connection, ErrorCode, WarpSqlError, connect } from "../../src/index.js";
import { autoCodec, chooseCodec, farLinkMs } from "../../src/compression.js";
import { FakeServer, arrow, json } from "./fake.js";

const quiet = { warn: () => {} };
const lz4Stream = new Uint8Array(readFileSync(new URL("./fixtures/lz4/pyarrow_lz4.arrows", import.meta.url)));

/** A fake server with both codecs, whose discovery answers after `discoveryDelays[i]` ms (the last repeats). */
function serverWith(capabilities: string[], discoveryDelays: number[] = [0]) {
  const server = new FakeServer();
  server.capabilities.push(...capabilities);
  let discoveries = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/warp") {
      const delay = discoveryDelays[Math.min(discoveries++, discoveryDelays.length - 1)]!;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return server.fetch(input, init);
  };
  return { server, fetch, discoveries: () => discoveries };
}

const open = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}): Promise<Connection> =>
  connect({ url: "warp://db.test:31337", username: "joe", password: "pw", fetch, logger: quiet, ...extra });

const both = ["ipc_compression_lz4_frame", "ipc_compression_zstd"];
const asked = (server: FakeServer) =>
  server.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/statements"));

function answerRows(server: FakeServer) {
  server.on("POST", /\/statements$/, () => arrow(tableFromArrays({ v: Int32Array.from([1]) })));
}

async function expectInvalid(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WarpSqlError);
  expect((err as WarpSqlError).code).toBe(ErrorCode.invalidArgument);
  expect((err as WarpSqlError).message).toMatch(pattern);
}

describe("choosing a codec (§8.2)", () => {
  test("auto: lz4_frame under 10 ms, zstd from 10 ms", () => {
    expect(farLinkMs).toBe(10);
    expect(autoCodec(0)).toBe("lz4_frame");
    expect(autoCodec(9.9)).toBe("lz4_frame");
    expect(autoCodec(10)).toBe("zstd");
    expect(autoCodec(80)).toBe("zstd");
  });

  test("a codec the server does not list is never chosen", () => {
    const has = (listed: string[]) => (c: string) => listed.includes(c);
    expect(chooseCodec("lz4_frame", has(both), 0)).toBe("lz4_frame");
    expect(chooseCodec("zstd", has(both), 0)).toBe("zstd");
    expect(chooseCodec("none", has(both), 0)).toBeUndefined();
    expect(chooseCodec("lz4_frame", has(["ipc_compression_zstd"]), 0)).toBeUndefined();
    expect(chooseCodec("zstd", has(["ipc_compression_lz4_frame"]), 0)).toBeUndefined();
    expect(chooseCodec("auto", has(["ipc_compression_zstd"]), 1)).toBeUndefined();
    expect(chooseCodec("auto", has(["ipc_compression_lz4_frame"]), 50)).toBeUndefined();
    expect(chooseCodec("auto", has([]), 1)).toBeUndefined();
  });

  test("ipcCompression accepts none, lz4_frame, zstd and auto, and refuses anything else before sending", async () => {
    const { server, fetch } = serverWith(both);
    answerRows(server);
    await expectInvalid(
      open(fetch, { ipcCompression: "lz4" }),
      /ipcCompression must be "none", "lz4_frame", "zstd", "auto"/,
    );
    expect(server.requests.length).toBe(0);
    const conn = await open(fetch);
    await expectInvalid(conn.query("SELECT 1", undefined, { ipcCompression: "gzip" as "zstd" }), /ipcCompression/);
    for (const value of ["none", "lz4_frame", "zstd", "auto"] as const) {
      await conn.query("SELECT 1", undefined, { ipcCompression: value });
    }
    expect(asked(server).map((r) => r.headers.get("warp-ipc-compression"))).toEqual([
      null,
      "lz4_frame",
      "zstd",
      "lz4_frame",
    ]);
  });

  test("the default is none: no header", async () => {
    const { server, fetch } = serverWith(both);
    answerRows(server);
    await (await open(fetch)).query("SELECT 1");
    expect(asked(server)[0]!.headers.has("warp-ipc-compression")).toBe(false);
  });

  test("a codec the server does not list is not asked for, explicitly or by auto", async () => {
    for (const [listed, setting] of [
      [["ipc_compression_zstd"], "lz4_frame"],
      [["ipc_compression_lz4_frame"], "zstd"],
      [["ipc_compression_zstd"], "auto"],
      [[], "auto"],
    ] as const) {
      const { server, fetch } = serverWith([...listed]);
      answerRows(server);
      await (await open(fetch, { ipcCompression: setting })).query("SELECT 1");
      expect(asked(server)[0]!.headers.has("warp-ipc-compression"), `${setting} with ${listed.join()}`).toBe(false);
    }
  });

  test("auto on a fast link asks for lz4_frame, timing discovery once", async () => {
    const { server, fetch, discoveries } = serverWith(both, [0]);
    answerRows(server);
    await (await open(fetch, { ipcCompression: "auto" })).query("SELECT 1");
    expect(asked(server)[0]!.headers.get("warp-ipc-compression")).toBe("lz4_frame");
    expect(discoveries()).toBe(1);
  });

  test("auto on a slow link asks for zstd, after timing discovery again on the open connection", async () => {
    const { server, fetch, discoveries } = serverWith(both, [30]);
    answerRows(server);
    await (await open(fetch, { ipcCompression: "auto" })).query("SELECT 1");
    expect(asked(server)[0]!.headers.get("warp-ipc-compression")).toBe("zstd");
    expect(discoveries()).toBe(2);
  });

  test("auto discounts a slow first discovery (connection setup) when the second is fast", async () => {
    const { server, fetch, discoveries } = serverWith(both, [30, 0]);
    answerRows(server);
    const conn = await open(fetch, { ipcCompression: "auto" });
    await conn.query("SELECT 1");
    await conn.query("SELECT 2", undefined, { ipcCompression: "auto" });
    expect(asked(server).map((r) => r.headers.get("warp-ipc-compression"))).toEqual(["lz4_frame", "lz4_frame"]);
    expect(discoveries()).toBe(2); // measured once per connection
  });
});

describe("the codec on every request that returns Arrow (§6.10, §8.2)", () => {
  test("streamed: the submit and each partition's GET carry it, and LZ4 results decode", async () => {
    const { server, fetch } = serverWith([...both, "result_partitions"]);
    const lz4 = () =>
      new Response(lz4Stream.slice(), {
        headers: { "content-type": "application/vnd.apache.arrow.stream", "warp-ipc-compression": "lz4_frame" },
      });
    server.on("POST", /\/statements$/, () => {
      const resp = lz4();
      resp.headers.set("warp-statement-id", "q1");
      resp.headers.set("warp-result-partitions", "3");
      resp.headers.set("warp-result-order", "any");
      return resp;
    });
    server.on("GET", /\/statements\/q1\/result$/, () => lz4());
    server.on("GET", /\/statements\/q1$/, () => json(200, { statement_id: "q1", state: "succeeded" }));
    const conn = await open(fetch, { ipcCompression: "lz4_frame", resultOrder: "any" });
    const table = await conn.query("SELECT * FROM t");
    expect(table.numRows).toBe(9000);
    const results = server.requests.filter((r) => r.url.pathname.endsWith("/result"));
    expect(results.map((r) => r.url.searchParams.get("partition")).sort()).toEqual(["1", "2"]);
    for (const r of [...asked(server), ...results]) expect(r.headers.get("warp-ipc-compression")).toBe("lz4_frame");
  });

  test("async: every partition's result GET carries it, and so do metadata requests", async () => {
    const { server, fetch } = serverWith([...both, "partitioned_results"]);
    server.on("POST", /\/statements$/, () =>
      json(201, {
        statement_id: "q1",
        state: "succeeded",
        result: {
          kind: "rows",
          partitions: [
            { index: 0, location: null },
            { index: 1, location: null },
          ],
          retained: true,
        },
      }),
    );
    server.on("GET", /\/statements\/q1\/result$/, () => arrow(tableFromArrays({ v: Int32Array.from([1, 2]) })));
    server.on("GET", /\/metadata\/table-types$/, () => arrow(tableFromArrays({ table_type: ["TABLE"] })));
    const conn = await open(fetch, { ipcCompression: "zstd", async: true });
    expect((await conn.query("SELECT v FROM t")).numRows).toBe(4);
    await conn.metadata.tableTypes();
    const arrowRequests = server.requests.filter((r) => /\/result$|\/metadata\//.test(r.url.pathname));
    expect(arrowRequests.length).toBe(3);
    for (const r of arrowRequests) expect(r.headers.get("warp-ipc-compression")).toBe("zstd");
  });
});

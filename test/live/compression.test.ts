// Licensed under the Apache License, Version 2.0.
//
// Arrow buffer compression (§8.2): the client asks for a codec on every request that
// returns Arrow, the server says what it used, and the rows are exactly the uncompressed
// ones, across a split result, with NULLs and an incompressible column (which a server
// may leave uncompressed inside a compressed stream: uncompressed length -1).

import { CompressionType, MessageReader, type Table } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { serverName } from "./harness.js";
import { FaultProxy, type RecordedRequest, isResultFetch, isSubmitOf, open, scalar } from "./helpers.js";

const rows = 500_000;
const sql =
  "SELECT i, hash(i)::DOUBLE AS h, CASE WHEN i % 3 = 0 THEN NULL ELSE i END AS n, 'v' || i AS s " +
  `FROM range(${rows}) t(i) ORDER BY i`;

const arrowType = "application/vnd.apache.arrow.stream";
const isArrowAnswer = (r: RecordedRequest) => String(r.answerHeaders?.["content-type"] ?? "").startsWith(arrowType);

/** The record batches' codecs and each non-empty buffer's uncompressed-length prefix (-1: left uncompressed). */
function bodyBuffers(answer: Buffer[]): { codecs: Set<number | undefined>; prefixes: number[] } {
  const reader = new MessageReader(new Uint8Array(Buffer.concat(answer)));
  const codecs = new Set<number | undefined>();
  const prefixes: number[] = [];
  for (let m = reader.readMessage(); m !== null; m = reader.readMessage()) {
    const body = reader.readMessageBody(m.bodyLength);
    if (!m.isRecordBatch()) continue;
    const header = m.header();
    codecs.add(header.compression?.type);
    if (header.compression === null) continue;
    for (const { offset, length } of header.buffers) {
      if (length > 0)
        prefixes.push(Number(new DataView(body.buffer, body.byteOffset + offset, 8).getBigInt64(0, true)));
    }
  }
  return { codecs, prefixes };
}

function expectRows(table: Table, plain: Table): void {
  expect(table.numRows).toBe(rows);
  const i = table.getChild("i")!.toArray() as BigInt64Array;
  const n = table.getChild("n")!;
  const s = table.getChild("s")!;
  const h = table.getChild("h")!.toArray() as Float64Array;
  const plainH = plain.getChild("h")!.toArray() as Float64Array;
  for (let r = 0; r < rows; r++) {
    const want = r % 3 === 0 ? null : BigInt(r);
    if (i[r] !== BigInt(r) || n.get(r) !== want || s.get(r) !== `v${r}` || !Object.is(h[r], plainH[r])) {
      throw new Error(`row ${r}: i=${i[r]} n=${n.get(r)} s=${s.get(r)} h=${h[r]} (uncompressed h=${plainH[r]})`);
    }
  }
}

describe("compressed results (§8.2)", () => {
  for (const codec of ["lz4_frame", "zstd"] as const) {
    for (const async of [false, true]) {
      test(`${codec}: every partition asked for and answered in it, rows exact (async: ${async})`, async () => {
        const proxy = await FaultProxy.start();
        proxy.keepAnswers = true;
        const conn = await open({ ipcCompression: codec, resultPartitions: 4, async }, proxy.info);
        expect(conn.capabilities.has(`ipc_compression_${codec}`)).toBe(true);
        const table = await conn.query(sql);
        const plain = await (await open({ resultPartitions: 1 })).query(sql);
        expectRows(table, plain);

        const arrow = proxy.requests(isArrowAnswer);
        const partitions = new Set(arrow.map((r) => r.query.get("partition") ?? "0"));
        expect(partitions.size, "a split result").toBeGreaterThan(1);
        if (async) expect(arrow.every(isResultFetch)).toBe(true);
        else expect(arrow.filter(isSubmitOf("hash(i)")).length).toBe(1);
        const prefixes: number[] = [];
        for (const r of arrow) {
          expect(r.headers["chargewire-ipc-compression"]).toBe(codec);
          expect(r.answerHeaders?.["chargewire-ipc-compression"]).toBe(codec);
          const seen = bodyBuffers(r.answer!);
          expect(seen.codecs).toEqual(new Set([codec === "zstd" ? CompressionType.ZSTD : CompressionType.LZ4_FRAME]));
          prefixes.push(...seen.prefixes);
        }
        expect(prefixes.some((p) => p > 0)).toBe(true);
        // Hardcharger leaves a buffer that would not shrink uncompressed (the hash column):
        // without one this test would not cover reading such buffers.
        if (serverName() === "Hardcharger") expect(prefixes.some((p) => p === -1)).toBe(true);
      });
    }
  }

  test("without the option nothing is asked for, and the server answers uncompressed", async () => {
    const proxy = await FaultProxy.start();
    proxy.keepAnswers = true;
    const conn = await open({ resultPartitions: 1 }, proxy.info);
    expect(await scalar(conn, "SELECT count(*) FROM range(10)")).toBe(10);
    const submit = proxy.requests(isSubmitOf("range(10)"))[0]!;
    expect(submit.headers["chargewire-ipc-compression"]).toBeUndefined();
    expect(submit.answerHeaders?.["chargewire-ipc-compression"] ?? "none").toBe("none");
    expect(bodyBuffers(submit.answer!).codecs).toEqual(new Set([undefined]));
  });

  test("auto picks lz4_frame on loopback", async () => {
    const proxy = await FaultProxy.start();
    const conn = await open({ ipcCompression: "auto", resultPartitions: 1 }, proxy.info);
    expect(await scalar(conn, "SELECT count(*) FROM range(10)")).toBe(10);
    expect(proxy.requests(isSubmitOf("range(10)"))[0]!.headers["chargewire-ipc-compression"]).toBe("lz4_frame");
  });
});

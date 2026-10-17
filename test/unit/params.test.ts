import { Int64, Schema, Field, TimestampMillisecond, Utf8, Null } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ErrorCode } from "../../src/index.js";
import { stringifyJSON } from "../../src/http.js";
import { checkJsonParameters, parameterRows } from "../../src/params.js";

describe("JSON parameters (§6.1)", () => {
  test("scalars pass; bigints are written as exact integers", () => {
    expect(checkJsonParameters([1, "a", true, null, 9007199254740993n])).toHaveLength(5);
    expect(stringifyJSON({ parameters: [9007199254740993n, "x"] })).toBe('{"parameters":[9007199254740993,"x"]}');
    expect(checkJsonParameters({ region: "EU" })).toEqual({ region: "EU" });
  });

  test("values JSON cannot carry are refused with a pointer to Arrow parameters", () => {
    for (const bad of [[new Date()], [Number.NaN], [Infinity], [undefined], [[1]], [{}], [new Uint8Array(1)]]) {
      expect(() => checkJsonParameters(bad)).toThrow(expect.objectContaining({ code: ErrorCode.invalidArgument }));
    }
    expect(() => checkJsonParameters("x" as never)).toThrow(
      expect.objectContaining({ code: ErrorCode.invalidArgument }),
    );
    expect(() => checkJsonParameters(new Map() as never)).toThrow(
      expect.objectContaining({ code: ErrorCode.invalidArgument }),
    );
  });
});

describe("parameter rows in the server's types (§7.1)", () => {
  const schema = new Schema([
    new Field("1", new Int64(), true),
    new Field("2", new Utf8(), true),
    new Field("3", new TimestampMillisecond(), true),
  ]);

  test("one Arrow row per execution, typed by the parameter schema", () => {
    const at = new Date("2026-10-17T12:00:00Z");
    const batch = parameterRows(schema, [
      [1n, "a", at],
      [2n, null, null],
    ]);
    expect(batch.numRows).toBe(2);
    expect(batch.schema.fields.map((f) => String(f.type))).toEqual(["Int64", "Utf8", "Timestamp<MILLISECOND>"]);
    expect(batch.getChildAt(0)!.get(1)).toBe(2n);
    expect(batch.getChildAt(1)!.get(1)).toBeNull();
    expect(batch.getChildAt(2)!.get(0)).toBe(at.getTime());
  });

  test("where the server does not know a type, the values decide", () => {
    const unknown = new Schema([new Field("1", new Null(), true)]);
    const batch = parameterRows(unknown, [["x"], ["y"]]);
    expect(String(batch.schema.fields[0]!.type)).toBe("Dictionary<Int32, Utf8>");
  });

  test("rows of the wrong width, or none, are refused", () => {
    expect(() => parameterRows(schema, [[1n, "a"]])).toThrow(
      expect.objectContaining({ code: ErrorCode.invalidArgument }),
    );
    expect(() => parameterRows(schema, [])).toThrow(expect.objectContaining({ code: ErrorCode.invalidArgument }));
  });
});

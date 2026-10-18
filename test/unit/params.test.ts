import { Int8, Int32, Int64, Uint8, Uint64, Schema, Field, TimestampMillisecond, Utf8, Null } from "apache-arrow";
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

  test("integers beyond 64 bits go as exact JSON integers (§6.1)", () => {
    const wide = [
      2n ** 63n - 1n,
      2n ** 64n - 1n,
      2n ** 64n,
      10n ** 38n - 1n,
      2n ** 127n,
      2n ** 128n - 1n,
      -(2n ** 127n),
    ];
    expect(
      JSON.parse(stringifyJSON({ p: wide }), (_k, v: unknown, ctx?: { source?: string }) =>
        typeof v === "number" ? ctx?.source : v,
      ),
    ).toEqual({ p: wide.map(String) });
    expect(stringifyJSON([10n ** 38n - 1n])).toBe("[99999999999999999999999999999999999999]");
  });

  test("a Number beyond the safe integers keeps its exact double value: exponent form, never rounded digits", () => {
    // JSON.stringify(2 ** 63) is "9223372036854776000", another integer than 2 ** 63, which a
    // server binds exactly as that (wrong) 64-bit integer. Exponent form is a double, read
    // back as exactly the same Number.
    for (const n of [2 ** 63, 2 ** 64, -(2 ** 64), 2 ** 53 + 2, 1e20, 10 ** 38, Number.MAX_VALUE]) {
      const text = stringifyJSON([n]);
      expect(text, String(n)).toMatch(/^\[-?\d(\.\d+)?e[+-]\d+\]$/);
      expect((JSON.parse(text) as number[])[0]).toBe(n);
    }
    // Safe integers and fractions are written as JSON.stringify writes them.
    expect(stringifyJSON([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1.5, 0, 42])).toBe(
      "[9007199254740991,-9007199254740991,1.5,0,42]",
    );
  });

  test("a string parameter never turns into a number, whatever it contains", () => {
    const tricky = ["\u0000bigint0\u0000", "\u0000bigint9\u0000", '"\u0000bigint0\u0000"'];
    const text = stringifyJSON({ parameters: [5n, ...tricky] });
    expect(JSON.parse(text)).toEqual({ parameters: [5, ...tricky] });
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

  const one = (type: Int8 | Int32 | Int64 | Uint8 | Uint64) => new Schema([new Field("1", type, true)]);
  const refused = (fn: () => unknown, message: RegExp) =>
    expect(fn).toThrow(
      expect.objectContaining({ code: ErrorCode.invalidArgument, message: expect.stringMatching(message) }),
    );

  test("an integer outside its parameter's type is refused, never wrapped", () => {
    // Arrow JS writes 2n ** 63n into an Int64 as -2n ** 63n, and 300 into a Uint8 as 44.
    refused(() => parameterRows(one(new Int64()), [[2n ** 63n]]), /out of range for Int64/);
    refused(() => parameterRows(one(new Int64()), [[-(2n ** 63n) - 1n]]), /out of range for Int64/);
    refused(() => parameterRows(one(new Uint64()), [[2n ** 64n]]), /out of range for Uint64/);
    refused(() => parameterRows(one(new Uint64()), [[-1n]]), /out of range for Uint64/);
    refused(() => parameterRows(one(new Uint8()), [[300]]), /out of range for Uint8/);
    refused(() => parameterRows(one(new Int8()), [[-129]]), /out of range for Int8/);
    refused(() => parameterRows(one(new Int32()), [[2 ** 40]]), /out of range for Int32/);
    // Not an integer, or a Number that is no longer exact: refused, not truncated or rounded.
    refused(() => parameterRows(one(new Int32()), [[1.5]]), /not an integer/);
    refused(() => parameterRows(one(new Int64()), [[2 ** 53 + 2]]), /beyond Number.MAX_SAFE_INTEGER/);
    // The edges themselves fit.
    expect(
      parameterRows(one(new Int64()), [[2n ** 63n - 1n], [-(2n ** 63n)]])
        .getChildAt(0)!
        .toArray(),
    ).toEqual(BigInt64Array.from([2n ** 63n - 1n, -(2n ** 63n)]));
    expect(
      parameterRows(one(new Uint64()), [[2n ** 64n - 1n]])
        .getChildAt(0)!
        .get(0),
    ).toBe(2n ** 64n - 1n);
    expect(
      parameterRows(one(new Uint8()), [[255], [null]])
        .getChildAt(0)!
        .get(0),
    ).toBe(255);
  });

  test("plain numbers and bigints both bind to any integer type that holds them", () => {
    expect(
      parameterRows(one(new Int64()), [[5], [Number.MAX_SAFE_INTEGER]])
        .getChildAt(0)!
        .get(1),
    ).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(
      parameterRows(one(new Int32()), [[7n]])
        .getChildAt(0)!
        .get(0),
    ).toBe(7);
  });

  test("an untyped bigint beyond 64 bits is refused, not wrapped into an Int64", () => {
    refused(() => parameterRows(undefined, [[2n ** 64n]]), /out of range for Int64/);
    expect(
      parameterRows(undefined, [[2n ** 63n - 1n]])
        .getChildAt(0)!
        .get(0),
    ).toBe(2n ** 63n - 1n);
  });

  test("rows of the wrong width, or none, are refused", () => {
    expect(() => parameterRows(schema, [[1n, "a"]])).toThrow(
      expect.objectContaining({ code: ErrorCode.invalidArgument }),
    );
    expect(() => parameterRows(schema, [])).toThrow(expect.objectContaining({ code: ErrorCode.invalidArgument }));
  });
});

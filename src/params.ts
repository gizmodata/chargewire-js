// Licensed under the Apache License, Version 2.0.

import {
  type Data,
  type DataType,
  Type,
  type Vector,
  Null,
  RecordBatch,
  type Schema,
  Struct,
  Table,
  isArrowRecordBatch,
  isArrowTable,
  makeData,
  vectorFromArray,
  Schema as ArrowSchema,
  Field,
} from "apache-arrow";

import { invalidArgument } from "./errors.js";

/** A bind-parameter value that travels as JSON (§6.1). A bigint is sent as an exact integer. */
export type JsonScalar = string | number | boolean | null | bigint;

/**
 * Bind parameters: values, never SQL text. An array binds positionally (`?`, `$1`), an
 * object by name (`$name`). For exact types (decimals, timestamps, binary, nested values)
 * pass Arrow data instead: each row of a Table or RecordBatch is one execution (§7.2).
 */
export type Parameters = readonly JsonScalar[] | Readonly<Record<string, JsonScalar>> | Table | RecordBatch;

export function isArrowParameters(params: Parameters | undefined): params is Table | RecordBatch {
  return params !== undefined && (isArrowTable(params) || isArrowRecordBatch(params));
}

/** Checks JSON parameters, so a value JSON cannot carry fails here and not on the server. */
export function checkJsonParameters(params: unknown): readonly JsonScalar[] | Readonly<Record<string, JsonScalar>> {
  const check = (value: unknown, where: string): void => {
    switch (typeof value) {
      case "string":
      case "boolean":
      case "bigint":
        return;
      case "number":
        if (!Number.isFinite(value)) throw invalidArgument(`parameter ${where} is ${value}, which JSON cannot carry`);
        return;
      case "object":
        if (value === null) return;
    }
    throw invalidArgument(
      `parameter ${where} is ${describe(value)}; JSON parameters are strings, numbers, bigints, booleans and null. ` +
        "For dates, binary or nested values, prepare the statement and pass Arrow data or use executeBatch",
    );
  };
  if (Array.isArray(params)) {
    params.forEach((value, i) => check(value, String(i + 1)));
    return params as JsonScalar[];
  }
  if (params !== null && typeof params === "object" && Object.getPrototypeOf(params) === Object.prototype) {
    for (const [name, value] of Object.entries(params)) check(value, JSON.stringify(name));
    return params as Record<string, JsonScalar>;
  }
  throw invalidArgument("parameters must be an array (positional), a plain object (named), or Arrow data");
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value instanceof Date) return "a Date";
  if (value instanceof Uint8Array) return "a Uint8Array";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? `a ${value?.constructor?.name ?? "object"}` : typeof value;
}

/**
 * Builds Arrow parameter rows from plain values in the server's parameter types (§7.1),
 * so dates, bigints and binary arrive exactly. Where the server does not know a
 * parameter's type, the values decide it.
 */
export function parameterRows(schema: Schema | undefined, rows: readonly (readonly unknown[])[]): RecordBatch {
  if (rows.length === 0) throw invalidArgument("executeBatch needs at least one row of parameters");
  const width = schema?.fields.length ?? rows[0]!.length;
  rows.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw invalidArgument(
        `parameter row ${i + 1} has ${Array.isArray(row) ? row.length : "no"} values; the statement takes ${width}`,
      );
    }
  });
  const children: Data[] = [];
  const fields: Field[] = [];
  for (let i = 0; i < width; i++) {
    const values: unknown[] = rows.map((row) => row[i]);
    const declared = schema?.fields[i]?.type as DataType | undefined;
    const type = declared === undefined || declared instanceof Null ? undefined : declared;
    let vector: Vector<DataType>;
    try {
      vector = toVector(values, type);
    } catch (err) {
      throw invalidArgument(
        `parameter ${i + 1} cannot be converted to ${type === undefined ? "an Arrow type" : Type[type.typeId]}: ${String(err)}`,
      );
    }
    const data: Data = vector.data.length === 1 ? vector.data[0]! : toVector([...vector], vector.type).data[0]!;
    children.push(data);
    fields.push(new Field(schema?.fields[i]?.name ?? String(i + 1), vector.type, true));
  }
  const batchSchema = new ArrowSchema(fields);
  return new RecordBatch(
    batchSchema,
    makeData({ type: new Struct(batchSchema.fields), length: rows.length, children }),
  );
}

/** vectorFromArray, typed: its overloads type a vector of unknown values as any. */
function toVector(values: unknown[], type: DataType | undefined): Vector<DataType> {
  return type === undefined ? vectorFromArray(values) : vectorFromArray(values, type);
}

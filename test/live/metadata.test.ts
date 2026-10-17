// Licensed under the Apache License, Version 2.0.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Connection, ErrorCode } from "../../src/index.js";
import { expectCode, open, openUnmanaged } from "./helpers.js";

const names = (rows: Iterable<{ toJSON(): Record<string, unknown> }>, key: string): unknown[] =>
  Array.from(rows, (r) => r.toJSON()[key]);

describe("metadata (§10)", () => {
  let conn: Connection;
  afterAll(() => conn?.close());
  beforeAll(async () => {
    conn = await openUnmanaged();
    await conn.execute("ATTACH IF NOT EXISTS ':memory:' AS meta_cat");
    await conn.execute("CREATE SCHEMA IF NOT EXISTS meta_cat.meta_s");
    await conn.execute(
      "CREATE OR REPLACE TABLE meta_cat.meta_s.parent (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL DEFAULT 'x', amount DECIMAL(12, 3))",
    );
    await conn.execute(
      "CREATE OR REPLACE TABLE meta_cat.meta_s.child (id INTEGER, parent_id INTEGER REFERENCES meta_cat.meta_s.parent(id))",
    );
    await conn.execute("CREATE OR REPLACE TABLE meta_cat.meta_s.under_score (v INTEGER)");
    await conn.execute("CREATE OR REPLACE TABLE meta_cat.meta_s.underXscore (v INTEGER)");
    await conn.execute("CREATE OR REPLACE VIEW meta_cat.meta_s.parent_view AS SELECT id FROM meta_cat.meta_s.parent");
  });

  test("catalogs, schemas and table types, with the Flight SQL schemas", async () => {
    const catalogs = await conn.metadata.catalogs();
    expect(catalogs.schema.fields.map((f) => f.name)).toEqual(["catalog_name"]);
    expect(names(catalogs, "catalog_name")).toContain("meta_cat");
    const schemas = await conn.metadata.dbSchemas({ catalog: "meta_cat", dbSchemaFilterPattern: "meta%" });
    expect(schemas.schema.fields.map((f) => f.name)).toEqual(["catalog_name", "db_schema_name"]);
    expect(names(schemas, "db_schema_name")).toEqual(["meta_s"]);
    const types = await conn.metadata.tableTypes();
    expect(names(types, "table_type")).toEqual(expect.arrayContaining(["BASE TABLE", "VIEW"]));
  });

  test("tables by pattern and type, with schemas; LIKE escapes", async () => {
    const tables = await conn.metadata.tables({
      catalog: "meta_cat",
      dbSchemaFilterPattern: "meta_s",
      tableNameFilterPattern: "par%",
    });
    expect(names(tables, "table_name").sort()).toEqual(["parent", "parent_view"]);
    const views = await conn.metadata.tables({ catalog: "meta_cat", tableTypes: ["VIEW"] });
    expect(names(views, "table_name")).toEqual(["parent_view"]);
    const escaped = await conn.metadata.tables({ catalog: "meta_cat", tableNameFilterPattern: "under\\_score" });
    expect(names(escaped, "table_name")).toEqual(["under_score"]);
    const both = await conn.metadata.tables({ catalog: "meta_cat", tableNameFilterPattern: "under_score" });
    expect(names(both, "table_name").sort()).toEqual(["underXscore", "under_score"]);
    const withSchema = await conn.metadata.tables({
      catalog: "meta_cat",
      tableNameFilterPattern: "parent",
      includeSchema: true,
    });
    expect(withSchema.schema.fields.map((f) => f.name)).toContain("table_schema");
  });

  test("columns from the tables' schemas: types, nullability, precision, defaults", async () => {
    const columns = await conn.metadata.columns({ catalog: "meta_cat", tableNameFilterPattern: "parent" });
    expect(columns.map((c) => c.columnName)).toEqual(["id", "name", "amount"]);
    const [id, name, amount] = columns;
    expect(id!.nullable).toBe(false); // primary key
    expect(name!.nullable).toBe(false);
    expect(name!.defaultValue).toContain("x");
    expect(amount!.nullable).toBe(true);
    expect(amount!.precision).toBe(12);
    expect(amount!.scale).toBe(3);
    expect(id!.ordinalPosition).toBe(1);
    const filtered = await conn.metadata.columns({
      catalog: "meta_cat",
      tableNameFilterPattern: "parent",
      columnNameFilterPattern: "n%",
    });
    expect(filtered.map((c) => c.columnName)).toEqual(["name"]);
  });

  test("primary, imported and exported keys, and cross references", async () => {
    const pk = await conn.metadata.primaryKeys({ catalog: "meta_cat", dbSchema: "meta_s", table: "parent" });
    expect(names(pk, "column_name")).toEqual(["id"]);
    const imported = await conn.metadata.importedKeys({ catalog: "meta_cat", dbSchema: "meta_s", table: "child" });
    expect(names(imported, "fk_column_name")).toEqual(["parent_id"]);
    expect(names(imported, "pk_table_name")).toEqual(["parent"]);
    const exported = await conn.metadata.exportedKeys({ catalog: "meta_cat", dbSchema: "meta_s", table: "parent" });
    expect(names(exported, "fk_table_name")).toEqual(["child"]);
    const cross = await conn.metadata.crossReference({
      pkCatalog: "meta_cat",
      pkDbSchema: "meta_s",
      pkTable: "parent",
      fkCatalog: "meta_cat",
      fkDbSchema: "meta_s",
      fkTable: "child",
    });
    expect(cross.numRows).toBe(1);
    expect(cross.schema.fields.length).toBe(13);
  });

  test("type info and server info", async () => {
    const types = await conn.metadata.typeInfo();
    expect(types.numRows).toBeGreaterThan(5);
    expect(types.schema.fields.map((f) => f.name)).toContain("type_name");
    const info = await conn.metadata.serverInfo();
    expect(typeof info["server_name"]).toBe("string");
  });

  test("session options: current catalog and schema; refusals name the option", async () => {
    await conn.setOptions({ catalog: "meta_cat", schema: "meta_s" });
    const session = await conn.getSession();
    expect(session.options).toMatchObject({ catalog: "meta_cat", schema: "meta_s" });
    expect((await conn.query("SELECT count(*) AS c FROM parent")).numRows).toBe(1); // unqualified, from the current schema
    const err = await expectCode(conn.setOptions({ no_such_option: 1 }), ErrorCode.unknownOption);
    expect(err.message).toContain("no_such_option");
    await expectCode(conn.setOptions({ schema: "no_such_schema" }), ErrorCode.invalidOptionValue);
    expect((await conn.getSession()).options?.["schema"]).toBe("meta_s"); // unchanged
    await conn.setOptions({ catalog: "memory", schema: "main" });
  });

  test("a SQL USE shows in the session document (§5.2)", async () => {
    const other = await open();
    await other.execute("USE meta_cat.meta_s");
    expect((await other.getSession()).options).toMatchObject({ catalog: "meta_cat", schema: "meta_s" });
  });
});

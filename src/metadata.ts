// Licensed under the Apache License, Version 2.0.

import {
  type Field,
  RecordBatchReader,
  type Table,
  type AsyncRecordBatchStreamReader,
  Table as ArrowTable,
} from "apache-arrow";

import type { Core } from "./core.js";
import { protocolError } from "./errors.js";
import { decodeJSON, mediaTypeArrow } from "./http.js";
import { ScannedBody, incompleteStream, schemaFromIpc } from "./ipc.js";
import { sessionPath } from "./session.js";

export interface MetadataCallOptions {
  signal?: AbortSignal;
}

/** A column, from the tables' Arrow schemas (§10). */
export interface ColumnInfo {
  catalogName: string | null;
  dbSchemaName: string | null;
  tableName: string;
  tableType: string;
  columnName: string;
  /** Position in the table, from 1. */
  ordinalPosition: number;
  /** The column as an Arrow field, with the server's per-field metadata. */
  field: Field;
  /** The engine's type name (`ARROW:FLIGHT:SQL:TYPE_NAME`), e.g. `DECIMAL`. */
  typeName: string | undefined;
  nullable: boolean;
  /** Decimal digits for numeric columns. */
  precision: number | undefined;
  scale: number | undefined;
  remarks: string | undefined;
  /** The default's SQL text (`WARP:SQL:COLUMN_DEFAULT`). */
  defaultValue: string | undefined;
}

/**
 * Catalog metadata (§10): Arrow tables whose schemas are exactly those of the matching
 * Arrow Flight SQL commands. Filter patterns use SQL `LIKE` syntax (`%`, `_`, `\` escape).
 */
export class Metadata {
  readonly #core: Core;

  /** @internal */
  constructor(core: Core) {
    this.#core = core;
  }

  /** `CommandGetCatalogs`: `catalog_name`. */
  catalogs(options: MetadataCallOptions = {}): Promise<Table> {
    return this.#get("catalogs", {}, options);
  }

  /** `CommandGetDbSchemas`: `catalog_name`, `db_schema_name`. */
  dbSchemas(options: { catalog?: string; dbSchemaFilterPattern?: string } & MetadataCallOptions = {}): Promise<Table> {
    return this.#get(
      "db-schemas",
      { catalog: options.catalog, db_schema_filter_pattern: options.dbSchemaFilterPattern },
      options,
    );
  }

  /** `CommandGetTables`: `catalog_name`, `db_schema_name`, `table_name`, `table_type` [, `table_schema`]. */
  tables(
    options: {
      catalog?: string;
      dbSchemaFilterPattern?: string;
      tableNameFilterPattern?: string;
      tableTypes?: readonly string[];
      includeSchema?: boolean;
    } & MetadataCallOptions = {},
  ): Promise<Table> {
    return this.#get(
      "tables",
      {
        catalog: options.catalog,
        db_schema_filter_pattern: options.dbSchemaFilterPattern,
        table_name_filter_pattern: options.tableNameFilterPattern,
        table_types: options.tableTypes?.join(","),
        include_schema: options.includeSchema ? "true" : undefined,
      },
      options,
    );
  }

  /** `CommandGetTableTypes`: `table_type`. */
  tableTypes(options: MetadataCallOptions = {}): Promise<Table> {
    return this.#get("table-types", {}, options);
  }

  /** `CommandGetPrimaryKeys`. Without `table`, every table's. */
  primaryKeys(
    options: { catalog?: string; dbSchema?: string; table?: string } & MetadataCallOptions = {},
  ): Promise<Table> {
    return this.#get(
      "primary-keys",
      { catalog: options.catalog, db_schema: options.dbSchema, table: options.table },
      options,
    );
  }

  /** `CommandGetImportedKeys`: the foreign keys of `table`. */
  importedKeys(
    options: { catalog?: string; dbSchema?: string; table?: string } & MetadataCallOptions = {},
  ): Promise<Table> {
    return this.#get(
      "imported-keys",
      { catalog: options.catalog, db_schema: options.dbSchema, table: options.table },
      options,
    );
  }

  /** `CommandGetExportedKeys`: the foreign keys that reference `table`. */
  exportedKeys(options: { catalog?: string; dbSchema?: string; table: string } & MetadataCallOptions): Promise<Table> {
    return this.#get(
      "exported-keys",
      { catalog: options.catalog, db_schema: options.dbSchema, table: options.table },
      options,
    );
  }

  /** `CommandGetCrossReference`: the foreign keys of `fkTable` that reference `pkTable`. */
  crossReference(
    options: {
      pkCatalog?: string;
      pkDbSchema?: string;
      pkTable: string;
      fkCatalog?: string;
      fkDbSchema?: string;
      fkTable: string;
    } & MetadataCallOptions,
  ): Promise<Table> {
    return this.#get(
      "cross-reference",
      {
        pk_catalog: options.pkCatalog,
        pk_db_schema: options.pkDbSchema,
        pk_table: options.pkTable,
        fk_catalog: options.fkCatalog,
        fk_db_schema: options.fkDbSchema,
        fk_table: options.fkTable,
      },
      options,
    );
  }

  /** `CommandGetXdbcTypeInfo`; `dataType` narrows it to one XDBC type number. */
  typeInfo(options: { dataType?: number } & MetadataCallOptions = {}): Promise<Table> {
    return this.#get(
      "type-info",
      { data_type: options.dataType === undefined ? undefined : String(options.dataType) },
      options,
    );
  }

  /** The server-info document: Flight SQL's SqlInfo names in lower case (`server_name`, …). */
  async serverInfo(options: MetadataCallOptions = {}): Promise<Record<string, unknown>> {
    const core = this.#core;
    core.checkOpen();
    await core.settle();
    const resp = await core.session.do("session", "", (id) => ({
      method: "GET",
      path: `${sessionPath(id)}/metadata/server-info`,
      idempotent: true,
      signal: options.signal,
    }));
    return decodeJSON<Record<string, unknown>>(resp);
  }

  /**
   * Every column of the tables that match, from their Arrow schemas. `columnNameFilterPattern`
   * is a `LIKE` pattern applied to column names.
   */
  async columns(
    options: {
      catalog?: string;
      dbSchemaFilterPattern?: string;
      tableNameFilterPattern?: string;
      columnNameFilterPattern?: string;
    } & MetadataCallOptions = {},
  ): Promise<ColumnInfo[]> {
    const tables = await this.tables({ ...options, includeSchema: true });
    const match =
      options.columnNameFilterPattern === undefined ? undefined : likeToRegExp(options.columnNameFilterPattern);
    const out: ColumnInfo[] = [];
    for (const row of tables as Iterable<Record<string, unknown>>) {
      const raw = row["table_schema"] as Uint8Array | null;
      if (raw === null || raw === undefined) continue;
      const schema = schemaFromIpc(raw);
      schema.fields.forEach((field, i) => {
        if (match !== undefined && !match.test(field.name)) return;
        const meta = field.metadata;
        const number = (key: string): number | undefined => {
          const value = meta.get(key);
          return value === undefined || value === "" ? undefined : Number(value);
        };
        out.push({
          catalogName: (row["catalog_name"] as string | null) ?? null,
          dbSchemaName: (row["db_schema_name"] as string | null) ?? null,
          tableName: row["table_name"] as string,
          tableType: row["table_type"] as string,
          columnName: field.name,
          ordinalPosition: i + 1,
          field,
          typeName: meta.get("ARROW:FLIGHT:SQL:TYPE_NAME"),
          nullable: field.nullable,
          precision: number("ARROW:FLIGHT:SQL:PRECISION"),
          scale: number("ARROW:FLIGHT:SQL:SCALE"),
          remarks: meta.get("ARROW:FLIGHT:SQL:REMARKS"),
          defaultValue: meta.get("WARP:SQL:COLUMN_DEFAULT"),
        });
      });
    }
    return out;
  }

  async #get(kind: string, query: Record<string, string | undefined>, options: MetadataCallOptions): Promise<Table> {
    const core = this.#core;
    core.checkOpen();
    await core.settle();
    const headers: Record<string, string> = { Accept: mediaTypeArrow };
    if (core.settings.ipcCodec !== undefined) headers["Warp-IPC-Compression"] = core.settings.ipcCodec;
    const resp = await core.session.do("session", "", (id) => ({
      method: "GET",
      path: `${sessionPath(id)}/metadata/${kind}`,
      query,
      headers,
      idempotent: true,
      signal: options.signal,
    }));
    return readTable(resp);
  }
}

/** Reads a whole Arrow response; a stream without its end-of-stream marker is an error. */
export async function readTable(resp: Response): Promise<Table> {
  if (resp.body === null || !(resp.headers.get("content-type") ?? "").startsWith(mediaTypeArrow)) {
    await resp.body?.cancel().catch(() => {});
    throw protocolError(`expected an Arrow stream, got ${resp.headers.get("content-type") ?? "no content type"}`);
  }
  const body = new ScannedBody(resp.body);
  const reader = (await RecordBatchReader.from(body)) as AsyncRecordBatchStreamReader;
  await reader.open();
  const batches = [];
  for await (const batch of reader) batches.push(batch);
  body.finish();
  if (!body.scanner.sawEos) throw incompleteStream();
  return new ArrowTable(reader.schema, batches);
}

/** A SQL LIKE pattern as a regular expression (`%`, `_`, `\` escape). */
export function likeToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[++i]!);
    } else if (c === "%") source += "[\\s\\S]*";
    else if (c === "_") source += "[\\s\\S]";
    else source += escapeRegExp(c);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

// Licensed under the Apache License, Version 2.0.

import type { ProblemDocument } from "./errors.js";

/**
 * The optional features of version 1 a server lists in its discovery document (§3.1).
 * Everything else is core. A client ignores capability names it doesn't know (§12).
 */
export const Capability = {
  preparedStatements: "prepared_statements",
  transactions: "transactions",
  ingest: "ingest",
  partitionedIngest: "partitioned_ingest",
  longPoll: "long_poll",
  ipcCompressionLz4Frame: "ipc_compression_lz4_frame",
  ipcCompressionZstd: "ipc_compression_zstd",
  /** Results split over several partitions on this server (§6.10). */
  resultPartitions: "result_partitions",
  /** Partitions held by other servers (§6.2): the client sends `Warp-Result-Locations: remote` to accept them. */
  resultLocations: "result_locations",
  mtlsIdentity: "mtls_identity",
  oauthBrowser: "oauth_browser",
} as const;

/** The document `GET /warp` returns (§3.1). */
export interface DiscoveryDocument {
  protocol: string;
  protocol_versions: string[];
  server?: { name?: string; version?: string };
  capabilities?: string[];
  auth?: {
    grant_types?: string[];
    /** Browser sign-in (§4.3), when the server offers it: the identity provider's name for people. */
    oauth_browser?: { provider?: string };
  };
  [key: string]: unknown;
}

/**
 * A session's transaction (§5.1): `none`, `open` (from BEGIN to its end, or while autocommit is
 * off), or `aborted` (a statement failed or was cancelled inside it, and the engine refuses every
 * statement until a rollback). `unknown`: the server sent a value this client doesn't know (§12).
 */
export type TransactionState = "none" | "open" | "aborted" | "unknown";

/** A session (§5.1). */
export interface SessionDocument {
  session_id: string;
  /** Every option the session has, with its current value. */
  options?: Record<string, unknown>;
  /**
   * Where the session's transaction stands, as the engine has it (§5.1). The client reports a
   * value it doesn't know (a later version's, §12) as `unknown`.
   */
  transaction: TransactionState;
  idle_timeout_s?: number;
}

/**
 * A statement's state (§6.2). `succeeded`, `failed` and `cancelled` are terminal; later
 * versions may add states, never terminal ones (§12), so an unknown state means "keep polling".
 */
export type StatementState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | (string & {});

/** Whether a statement's state is final. An unknown state is not (§12). */
export function isTerminal(state: StatementState | undefined): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** A session's transaction as {@link TransactionState}: a value this client doesn't know is `unknown` (§12). */
export function transactionState(value: unknown): TransactionState {
  return value === "none" || value === "open" || value === "aborted" ? value : "unknown";
}

/** One piece of a row result (§6.2). */
export interface PartitionDocument {
  index: number;
  location?: string | null;
  batches?: number | null;
  rows?: number | null;
}

export interface ResultDocument {
  kind: "rows" | "update" | (string & {});
  schema?: string;
  partitions?: PartitionDocument[];
  /** `interleaved` or `any` when the result has more than one partition (§6.10). */
  partition_order?: "interleaved" | "any" | (string & {});
  retained?: boolean;
  expires_at?: string;
  rows_affected?: number;
}

/** A statement's status (§6.2). */
export interface StatementDocument {
  statement_id: string;
  state: StatementState;
  submitted_at?: string;
  /** Once it has started (a statement cancelled while queued never has one). */
  started_at?: string;
  /** In a terminal state. */
  finished_at?: string;
  progress?: { fraction?: number; rows_produced?: number };
  /** On `failed` and `cancelled`. */
  error?: ProblemDocument;
  /** On `cancelled`: `client`, `timeout`, `session_closed`, `killed`, `cancelled`, `privilege_revoked`, `server_shutdown`, or a later one (§12). */
  cancel_reason?: string;
  result?: ResultDocument | null;
}

/** A prepared statement (§7.1). */
export interface PreparedDocument {
  prepared_id: string;
  parameter_schema?: string;
  result_schema?: string | null;
  result_kind?: "rows" | "update" | null;
}

/** The answer to `PATCH /sessions/{id}` (§5.3). */
export interface OptionsResult {
  /** Every option the session has after the request; a failed option keeps its earlier value. */
  options?: Record<string, unknown>;
  /** The failures by option name; `{}` when every option was set. */
  errors?: Record<string, ProblemDocument>;
}

/**
 * The server-info document (§10): Flight SQL `SqlInfo` names with a leading `FLIGHT_SQL_`
 * dropped, in lower case. The keys below are version 1's; a server includes those it knows,
 * so a missing key means unknown, not false. A server's own keys take its prefix
 * (`duckdb_version`, `hardcharger_instance_id`, §2.7); later versions add more `SqlInfo` names.
 */
export interface ServerInfo {
  server_name?: string;
  server_version?: string;
  server_arrow_version?: string;
  server_read_only?: boolean;
  sql_identifier_quote_char?: string;
  sql_transactions_supported?: boolean;
  [key: string]: unknown;
}

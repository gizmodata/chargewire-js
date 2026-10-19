// Licensed under the Apache License, Version 2.0.

import type { ProblemDocument } from "./errors.js";

/** Optional features a server lists in its discovery document (§3.1). */
export const Capability = {
  preparedStatements: "prepared_statements",
  transactions: "transactions",
  ingest: "ingest",
  resultRetention: "result_retention",
  longPoll: "long_poll",
  ipcCompressionLz4Frame: "ipc_compression_lz4_frame",
  ipcCompressionZstd: "ipc_compression_zstd",
  partitionedResults: "partitioned_results",
  resultPartitions: "result_partitions",
  partitionedIngest: "partitioned_ingest",
  oauthBrowser: "oauth_browser",
  mtlsIdentity: "mtls_identity",
} as const;

/** The document `GET /warp` returns (§3.1). */
export interface DiscoveryDocument {
  protocol: string;
  protocol_versions: string[];
  draft?: string;
  server?: { name?: string; version?: string };
  capabilities?: string[];
  auth?: { grant_types?: string[] };
  [key: string]: unknown;
}

/** A session (§5.1). */
export interface SessionDocument {
  session_id: string;
  options?: Record<string, unknown>;
  idle_timeout_s?: number;
}

export type StatementState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export function isTerminal(state: StatementState | undefined): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** One piece of a row result (§6.2). */
export interface PartitionDocument {
  index: number;
  location?: string | null;
  batches?: number | null;
  rows?: number | null;
}

export interface ResultDocument {
  kind: "rows" | "update";
  schema?: string;
  partitions?: PartitionDocument[];
  /** `interleaved` or `any` for a result split on this server (§6.10). */
  partition_order?: "interleaved" | "any";
  retained?: boolean;
  expires_at?: string;
  rows_affected?: number;
}

/** A statement's status (§6.2). */
export interface StatementDocument {
  statement_id: string;
  state: StatementState;
  submitted_at?: string;
  started_at?: string;
  progress?: { fraction?: number; rows_produced?: number };
  error?: ProblemDocument;
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
  options?: Record<string, unknown>;
  errors?: Record<string, ProblemDocument>;
}

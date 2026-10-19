// Licensed under the Apache License, Version 2.0.

/**
 * @packageDocumentation
 * A client for the Warp SQL protocol (https://github.com/gizmodata/warp-sql): SQL over
 * plain HTTP, with results, parameters and uploads as Apache Arrow IPC streams.
 */

export {
  connect,
  Connection,
  PreparedStatement,
  type CallOptions,
  type ConnectOptions,
  type IngestOptions,
  type StatementOptions,
} from "./connection.js";
export { ResultStream } from "./stream.js";
export {
  beginBrowserRedirectSignIn,
  browserSignIn,
  browserSignInFragmentKey,
  browserSignInProvider,
  completeBrowserRedirectSignIn,
  pollBrowserSignIn,
  startBrowserSignIn,
  takeBrowserSignInFlowId,
  type BrowserSignInFlow,
  type BrowserSignInPoll,
  type BrowserSignInResult,
  type BrowserSignInStorage,
  type BrowserSignInTarget,
} from "./oauth.js";
export { Metadata, type ColumnInfo, type MetadataCallOptions } from "./metadata.js";
export {
  ErrorCode,
  WarpSqlError,
  type KnownErrorCode,
  type ProblemDocument,
  type SessionEndedReason,
  type WarpSqlErrorInit,
} from "./errors.js";
export type { JsonScalar, Parameters } from "./params.js";
export type { ArrowInput } from "./ipc.js";
export type { Logger } from "./http.js";
export type { TlsOptions } from "./platform/types.js";
export { Capability } from "./protocol.js";
export type {
  DiscoveryDocument,
  SessionDocument,
  StatementDocument,
  StatementState,
  TransactionState,
} from "./protocol.js";
export { defaultSchemes, parseUrl, type SchemeDefinition, type SchemeMap } from "./url.js";

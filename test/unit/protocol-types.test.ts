// The client's string unions against the spec's tables: §4.2 (invalid_token reasons), §5.1
// (transaction), §5.6 (session_ended reasons), §6.2 (cancel reasons) and §3.1 (capabilities).
// Most of the checking is done by the compiler (`npm run typecheck`): each `satisfies Record<…>`
// below needs exactly the union's named members as keys, no more and no fewer, so a reason
// added to the spec but not to the type (or the other way round) fails the typecheck.

import { describe, expect, test } from "vitest";

import {
  Capability,
  ChargewireError,
  ErrorCode,
  type CancelReason,
  type InvalidTokenReason,
  type SessionDocument,
  type SessionEndedReason,
  type TransactionState,
} from "../../src/index.js";
import { tokenRenewable } from "../../src/errors.js";
import { isSessionLost, lostTransaction } from "../../src/session.js";

/** The named members of an open string union: `"a" | "b" | (string & {})` is `"a" | "b"`. */
type Named<T> = T extends string ? (string extends T ? never : T) : never;

// Hardcharger 2.7.0 (Chargewire 2.1.0) ends sessions with this reason; consumers must be able to
// narrow on it, not only pass it through the open `(string & {})` part of the union.
const idleInTransaction: Named<SessionEndedReason> = "idle_in_transaction";

/** §5.6, and what the client does with each: replace the session, and whether a transaction was lost. */
const sessionEnded = {
  killed: { replaced: false, renewable: false, transactionLost: false },
  credentials_changed: { replaced: false, renewable: false, transactionLost: false },
  principal_dropped: { replaced: false, renewable: false, transactionLost: false },
  token_revoked: { replaced: false, renewable: false, transactionLost: false },
  token_expired: { replaced: false, renewable: true, transactionLost: false },
  idle_in_transaction: { replaced: true, renewable: true, transactionLost: true },
} satisfies Record<Named<SessionEndedReason>, { replaced: boolean; renewable: boolean; transactionLost: boolean }>;

/** §4.2, and whether the client may sign in again on its own after each. */
const invalidToken = {
  token_expired: true,
  token_revoked: false,
  credentials_changed: false,
  principal_dropped: false,
} satisfies Record<Named<InvalidTokenReason>, boolean>;

/** §6.2. */
const cancelReasons = {
  client: true,
  timeout: true,
  session_closed: true,
  killed: true,
  cancelled: true,
  privilege_revoked: true,
  server_shutdown: true,
} satisfies Record<Named<CancelReason>, true>;

/** §5.1, plus the client's own `unknown` for a value it doesn't know (§12). */
const transactionStates = { none: true, open: true, aborted: true, unknown: true } satisfies Record<
  TransactionState,
  true
>;

/** §5.1's session document, every field. */
const sessionDocument: Required<SessionDocument> = {
  session_id: "s_1",
  options: { autocommit: true },
  transaction: "none",
  idle_timeout_s: 900,
  idle_in_transaction_timeout_s: 0,
};

const ended = (reason: string): ChargewireError =>
  new ChargewireError({ code: ErrorCode.sessionEnded, status: 401, reason });

describe("string unions match the spec", () => {
  test("session_ended reasons (§5.6): idle_in_transaction replaces the session and counts as a lost transaction", () => {
    expect(idleInTransaction).toBe("idle_in_transaction");
    for (const [reason, want] of Object.entries(sessionEnded)) {
      const err = ended(reason);
      // Without a way to get a new token, only a reason that leaves the token standing is cured by a new session.
      expect(isSessionLost(err, false), reason).toBe(want.replaced);
      expect(isSessionLost(err, true), reason).toBe(want.renewable);
      expect(lostTransaction(err), reason).toBe(want.transactionLost);
    }
    // A reason this client doesn't know (§12) is reported, not papered over.
    expect(isSessionLost(ended("some_later_reason"), true)).toBe(false);
    expect(lostTransaction(ended("some_later_reason"))).toBe(false);
  });

  test("invalid_token reasons (§4.2)", () => {
    for (const [reason, renewable] of Object.entries(invalidToken)) {
      expect(tokenRenewable(reason), reason).toBe(renewable);
    }
  });

  test("cancel reasons (§6.2) and transaction states (§5.1)", () => {
    expect(Object.keys(cancelReasons)).toHaveLength(7);
    expect(Object.keys(transactionStates)).toHaveLength(4);
    expect(Object.keys(sessionDocument).sort()).toEqual([
      "idle_in_transaction_timeout_s",
      "idle_timeout_s",
      "options",
      "session_id",
      "transaction",
    ]);
  });

  test("capabilities (§3.1)", () => {
    expect(Object.values(Capability).sort()).toEqual(
      [
        "prepared_statements",
        "transactions",
        "ingest",
        "partitioned_ingest",
        "long_poll",
        "ipc_compression_lz4_frame",
        "ipc_compression_zstd",
        "result_partitions",
        "result_locations",
        "mtls_identity",
        "oauth_browser",
        "openapi",
      ].sort(),
    );
  });
});

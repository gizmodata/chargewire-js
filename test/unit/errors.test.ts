import { describe, expect, test } from "vitest";

import { ErrorCode, WarpSqlError } from "../../src/index.js";
import { parseRetryAfter, responseError, tokenRenewable } from "../../src/errors.js";

const problem = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });

describe("problem documents (§11)", () => {
  test("every field of a problem document reaches the error", async () => {
    const err = await responseError(
      problem(
        403,
        {
          type: "urn:warp-sql:error:permission_denied",
          title: "Permission denied",
          status: 403,
          code: "permission_denied",
          detail: "SELECT on lake.raw.events needs a grant",
          sqlstate: "42501",
          request_id: "r_1",
        },
        { "retry-after": "3" },
      ),
    );
    expect(err).toBeInstanceOf(WarpSqlError);
    expect(err).toMatchObject({
      code: "permission_denied",
      status: 403,
      sqlstate: "42501",
      requestId: "r_1",
      detail: "SELECT on lake.raw.events needs a grant",
      retryAfterMs: 3000,
    });
    expect(err.message).toContain("SELECT on lake.raw.events needs a grant");
    expect(err.message).toContain("SQLSTATE 42501");
  });

  test("session_ended carries its reason", async () => {
    const err = await responseError(problem(401, { code: "session_ended", reason: "killed", status: 401 }));
    expect(err.reason).toBe("killed");
  });

  test("an answer that is not a problem document is the client's own client_http_error, with its status", async () => {
    const err = await responseError(
      new Response("<html>Bad gateway</html>", { status: 502, headers: { "warp-request-id": "r_9" } }),
    );
    expect(err.code).toBe(ErrorCode.clientHttpError);
    expect(err.status).toBe(502);
    expect(err.requestId).toBe("r_9");
    const notFound = await responseError(new Response("", { status: 404, statusText: "Not Found" }));
    expect(notFound.code).toBe(ErrorCode.clientHttpError);
    expect(notFound.status).toBe(404);
    expect(notFound.detail).toBe("Not Found");
    // JSON without a code is no problem document either.
    const noCode = await responseError(problem(500, { status: 500, detail: "x" }));
    expect(noCode.code).toBe(ErrorCode.clientHttpError);
  });

  test("codes the client makes up begin with client_, and no server code does (§11)", () => {
    const client = [
      ErrorCode.clientInvalidArgument,
      ErrorCode.clientTransportError,
      ErrorCode.clientProtocolError,
      ErrorCode.clientHttpError,
      ErrorCode.clientIncompleteStream,
      ErrorCode.clientResultBufferExceeded,
      ErrorCode.clientConnectionClosed,
      ErrorCode.clientSignInTimeout,
    ];
    for (const [key, code] of Object.entries(ErrorCode)) {
      expect(code.startsWith("client_"), key).toBe((client as string[]).includes(code));
      expect(key.startsWith("client"), key).toBe(code.startsWith("client_"));
    }
  });

  test("ErrorCode has every server code of version 1 (§11)", () => {
    const v1 = [
      "bad_request",
      "unknown_option",
      "invalid_option_value",
      "sql_error",
      "unsupported_grant_type",
      "invalid_credentials",
      "invalid_token",
      "session_ended",
      "certificate_required",
      "unknown_certificate_identity",
      "certificate_revoked",
      "certificate_mismatch",
      "certificate_identity_mismatch",
      "permission_denied",
      "read_only",
      "session_not_found",
      "statement_not_found",
      "prepared_not_found",
      "ingest_not_found",
      "partition_not_found",
      "not_found",
      "method_not_allowed",
      "result_not_ready",
      "result_not_resumable",
      "ingest_incomplete",
      "ingest_part_exists",
      "statement_cancelled",
      "statement_timeout",
      "result_expired",
      "ingest_expired",
      "payload_too_large",
      "unsupported_arrow_type",
      "session_elsewhere",
      "idempotency_key_reused",
      "execution_error",
      "too_many_sessions",
      "result_quota_exceeded",
      "rate_limited",
      "headers_too_large",
      "internal_error",
      "not_implemented",
      "server_draining",
      // Browser sign-in (§4.3): flow_not_found (404), invalid_return_to (400), and a failed flow's error.code values.
      "flow_not_found",
      "invalid_return_to",
      "access_denied",
      "identity_provider_error",
    ];
    const server = Object.values(ErrorCode).filter((c) => !c.startsWith("client_"));
    expect([...server].sort()).toEqual([...v1].sort());
  });

  test("a cancelled statement's error response carries its statement and cancel_reason (§6.1)", async () => {
    const err = await responseError(
      problem(
        409,
        { code: "statement_cancelled", status: 409, cancel_reason: "privilege_revoked" },
        { "warp-statement-id": "q_7" },
      ),
    );
    expect(err).toMatchObject({
      code: "statement_cancelled",
      status: 409,
      statementId: "q_7",
      cancelReason: "privilege_revoked",
    });
    // An unknown cancel_reason is kept as sent, a generic one (§12).
    const later = await responseError(
      problem(409, { code: "statement_cancelled", cancel_reason: "some_future_reason" }),
    );
    expect(later.cancelReason).toBe("some_future_reason");
  });

  test("invalid_token reasons: sign in again without one, on token_expired or an unknown one; not after a deliberate end (§4.2)", () => {
    expect(tokenRenewable(undefined)).toBe(true);
    expect(tokenRenewable("token_expired")).toBe(true);
    expect(tokenRenewable("some_future_reason")).toBe(true);
    expect(tokenRenewable("token_revoked")).toBe(false);
    expect(tokenRenewable("credentials_changed")).toBe(false);
    expect(tokenRenewable("principal_dropped")).toBe(false);
  });

  test("unknown codes are kept as sent (§12)", async () => {
    const err = await responseError(problem(409, { code: "some_future_code", status: 409 }));
    expect(err.code).toBe("some_future_code");
  });

  test("Retry-After is integer delta-seconds (§2.6)", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    expect(parseRetryAfter("1.5")).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  test("WarpSqlError.is checks the class and the code", () => {
    const err = new WarpSqlError({ code: "sql_error" });
    expect(WarpSqlError.is(err)).toBe(true);
    expect(WarpSqlError.is(err, "sql_error", "x")).toBe(true);
    expect(WarpSqlError.is(err, "x")).toBe(false);
    expect(WarpSqlError.is(new Error("sql_error"), "sql_error")).toBe(false);
  });
});

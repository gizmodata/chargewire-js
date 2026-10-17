import { describe, expect, test } from "vitest";

import { ErrorCode, WarpSqlError } from "../../src/index.js";
import { codeForStatus, parseRetryAfter, responseError } from "../../src/errors.js";

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

  test("an answer that is not a problem document still has a code, from its status", async () => {
    const err = await responseError(
      new Response("<html>Bad gateway</html>", { status: 502, headers: { "warp-request-id": "r_9" } }),
    );
    expect(err.code).toBe(ErrorCode.executionError);
    expect(err.status).toBe(502);
    expect(err.requestId).toBe("r_9");
    const notFound = await responseError(new Response("", { status: 404, statusText: "Not Found" }));
    expect(notFound.code).toBe(ErrorCode.notFound);
    expect(notFound.detail).toBe("Not Found");
  });

  test("unknown codes are kept as sent (§12)", async () => {
    const err = await responseError(problem(409, { code: "some_future_code", status: 409 }));
    expect(err.code).toBe("some_future_code");
  });

  test("codeForStatus and Retry-After", () => {
    expect(codeForStatus(401)).toBe("invalid_token");
    expect(codeForStatus(429)).toBe("rate_limited");
    expect(codeForStatus(503)).toBe("server_draining");
    expect(codeForStatus(418)).toBe("bad_request");
    expect(parseRetryAfter("7")).toBe(7000);
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

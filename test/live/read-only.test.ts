import { expect, test } from "vitest";
import { discoveryStopped, expectCode, open, scalar } from "./helpers.js";

test("requested read-only allows reads and refuses writes without fallback", async () => {
  const conn = await open({ sessionOptions: { read_only: true } });
  expect((await conn.getSession()).options?.["read_only"]).toBe(true);
  expect(await scalar(conn, "SELECT 42 AS answer")).toBe(42);
  await expectCode(conn.execute("CREATE TABLE js_readonly_probe (id INTEGER)"), "read_only");
  expect(
    await scalar(conn, "SELECT count(*) FROM information_schema.tables WHERE table_name='js_readonly_probe'"),
  ).toBe(0);
  await expectCode(conn.setOptions({ read_only: false }), "read_only");
});

test("lazy read-only is confirmed on first work", async () => {
  const conn = await open({ fetch: discoveryStopped });
  await conn.setOptions({ read_only: true });
  expect(conn.sessionId).toBe("");
  await expectCode(conn.setOptions({ read_only: false }), "read_only");
  expect(await scalar(conn, "SELECT 42 AS answer")).toBe(42);
  expect((await conn.getSession()).options?.["read_only"]).toBe(true);
});

test("an existing session can become read-only", async () => {
  const conn = await open();
  expect((await conn.setOptions({ read_only: true }))["read_only"]).toBe(true);
  expect(await scalar(conn, "SELECT 42 AS answer")).toBe(42);
  await expectCode(conn.execute("CREATE TABLE js_readonly_transition_probe (id INTEGER)"), "read_only");
});

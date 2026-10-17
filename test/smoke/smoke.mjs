/* global Deno, Bun */
// One pass over the client's main paths, run under Node, Deno and Bun by run.mjs.
// It imports the package by name (its export conditions pick the build), or the module
// in WARP_SQL_JS_SMOKE_IMPORT.
const specifier = globalThis.process?.env?.WARP_SQL_JS_SMOKE_IMPORT ?? "@gizmodata/warp-sql";
const { connect, WarpSqlError } = await import(specifier);
const { tableFromArrays } = await import("apache-arrow");

const env = (name) => globalThis.process?.env?.[name] ?? globalThis.Deno?.env.get(name);
const conn = await connect({
  url: env("WARP_SQL_JS_SMOKE_URL"),
  username: "warp_test",
  password: env("WARP_SQL_JS_SMOKE_PASSWORD"),
});
const check = (ok, what) => {
  if (!ok) throw new Error(`smoke check failed: ${what}`);
};

const table = await conn.query("SELECT i, i * 2 AS j FROM range(200000) t(i) ORDER BY i DESC");
check(table.numRows === 200000 && table.get(0).i === 199999n, "query");
let rows = 0;
for await (const batch of conn.stream("SELECT * FROM range(300000)")) rows += batch.numRows;
check(rows === 300000, "stream");
check((await conn.query("SELECT ?::INTEGER + 1 AS v", [41])).get(0).v === 42, "parameters");
check(
  (await conn.ingest("smoke_t", tableFromArrays({ v: Int32Array.from([1, 2, 3]) }), { mode: "replace" })) === 3,
  "ingest",
);
const insert = await conn.prepare("INSERT INTO smoke_t VALUES (?)");
check((await insert.executeBatch([[4], [5]])) === 2, "prepared");
check((await conn.metadata.tables({ tableNameFilterPattern: "smoke_t" })).numRows === 1, "metadata");
let code = "";
try {
  await conn.query("SELEC 1");
} catch (err) {
  code = err instanceof WarpSqlError ? err.code : String(err);
}
check(code === "sql_error", `error code (${code})`);
const controller = new AbortController();
setTimeout(() => controller.abort(), 300);
try {
  await conn.query("SELECT sum(a.range * b.range) FROM range(100000000) a, range(100000) b", undefined, {
    signal: controller.signal,
  });
  code = "";
} catch (err) {
  code = err instanceof WarpSqlError ? err.code : String(err);
}
check(code === "statement_cancelled", `cancel (${code})`);
check((await conn.query("SELECT 1 AS one")).numRows === 1, "usable after cancel");
await conn.close();
const runtime = globalThis.Deno
  ? `Deno ${Deno.version.deno}`
  : globalThis.Bun
    ? `Bun ${Bun.version}`
    : `Node ${process.version}`;
console.log(`smoke ok: ${runtime}`);

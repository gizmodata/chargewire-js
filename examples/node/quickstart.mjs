// Run: CHARGEWIRE_URL=chargewire://127.0.0.1:31337?tls=false CHARGEWIRE_USER=... CHARGEWIRE_PASSWORD=... node examples/node/quickstart.mjs
import { tableFromArrays } from "apache-arrow";
import { ChargewireError, connect } from "@gizmodata/chargewire";

const conn = await connect({
  url: process.env.CHARGEWIRE_URL,
  username: process.env.CHARGEWIRE_USER,
  password: process.env.CHARGEWIRE_PASSWORD,
});

// A query, with bind parameters: an Arrow Table back.
const table = await conn.query("SELECT 42 AS answer, ?::VARCHAR AS greeting", ["hello"]);
console.log(table.toArray().map((row) => row.toJSON()));

// A big result, streamed batch by batch.
let rows = 0;
for await (const batch of conn.stream("SELECT * FROM range(10000000)")) rows += batch.numRows;
console.log(`streamed ${rows} rows`);

// Bulk ingest from Arrow, then a prepared statement run once per row.
await conn.ingest("events", tableFromArrays({ id: Int32Array.from([1, 2, 3]) }), { mode: "replace" });
const insert = await conn.prepare("INSERT INTO events VALUES (?)");
console.log(`inserted ${await insert.executeBatch([[4], [5]])} rows`);

// Errors carry the server's code; an AbortSignal cancels the statement on the server.
try {
  await conn.query("SELECT sum(a.range * b.range) FROM range(100000000) a, range(100000) b", undefined, {
    signal: AbortSignal.timeout(1000),
  });
} catch (err) {
  if (!(err instanceof ChargewireError)) throw err;
  console.log(`${err.code}: ${err.message}`);
}

await conn.close();

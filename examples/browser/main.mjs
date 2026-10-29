// The example page's script. `serve.mjs` bundles it with esbuild, which picks the
// package's browser build through its export conditions.
import { ChargewireError, connect } from "@gizmodata/chargewire";
import { tableFromArrays } from "apache-arrow";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
$("url").value = params.get("url") ?? ""; // the server and user name may be prefilled, the password never
$("username").value = params.get("username") ?? "";

let connection;
let connectedTo = "";
let running;

function show(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "error" : "";
}

function render(schema, rows) {
  const table = $("result");
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const field of schema.fields) head.appendChild(document.createElement("th")).textContent = field.name;
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const field of schema.fields) tr.insertCell().textContent = String(row[field.name]);
  }
}

$("query").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = $("url").value.trim();
  const username = $("username").value;
  running?.abort();
  running = new AbortController();
  const started = performance.now();
  show("running…");
  try {
    if (connection === undefined || connectedTo !== `${url} ${username}`) {
      await connection?.close();
      connection = await connect({ url, username, password: $("password").value });
      connectedTo = `${url} ${username}`;
    }
    const stream = connection.stream($("sql").value, undefined, { signal: running.signal });
    const schema = await stream.schema();
    const rows = [];
    let total = 0;
    for await (const batch of stream) {
      total += batch.numRows;
      for (const row of batch) if (rows.length < 1000) rows.push(row.toJSON());
    }
    render(schema, rows);
    show(`${total} row(s) in ${Math.round(performance.now() - started)} ms`);
  } catch (err) {
    show(err instanceof ChargewireError ? `${err.code}: ${err.message}` : String(err), true);
  }
});

$("cancel").addEventListener("click", () => running?.abort());

// For the browser smoke test, which scripts the client directly.
globalThis.chargewire = { connect, ChargewireError, tableFromArrays };

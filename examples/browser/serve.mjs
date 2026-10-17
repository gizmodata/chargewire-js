// Serves the example page: bundles main.mjs (and with it @gizmodata/warp-sql's browser
// build and Apache Arrow) with esbuild, then serves both on http://localhost:5173.
//
//   npm run build && npm run example:browser
//
// The Warp SQL server must allow the page's origin, e.g. warp-duckdb --cors-origin
// http://localhost:5173 or hardcharger --cors-origins http://localhost:5173.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { build } from "esbuild";

const here = new URL(".", import.meta.url);
const port = Number(process.env.PORT ?? 5173);

const bundle = await build({
  entryPoints: [new URL("main.mjs", here).pathname],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  minify: true,
  write: false,
});
const script = bundle.outputFiles[0].contents;
const page = await readFile(new URL("index.html", here));

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  } else if (path === "/main.js") {
    res.writeHead(200, { "content-type": "text/javascript" }).end(script);
  } else {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`example page on http://localhost:${port} (${Math.round(script.byteLength / 1024)} KiB script)`);
});

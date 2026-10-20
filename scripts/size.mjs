// Prints the client's bundle size for browsers: the web build minified, without its
// peer dependency (apache-arrow) and the lazily loaded decoders (fzstd, this package's
// LZ4 frame decoder), then with them. Code split off behind a dynamic import is counted
// apart: a page downloads it only when a connection uses that codec.
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

async function measure(label, external) {
  const result = await build({
    entryPoints: ["dist/web/index.mjs"],
    bundle: true,
    splitting: true,
    outdir: "size",
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2023",
    write: false,
    metafile: true,
    external,
    logLevel: "silent",
  });
  const entry = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint !== undefined)[0];
  const size = (files) => ({
    bytes: files.reduce((n, f) => n + f.contents.byteLength, 0),
    gzip: files.reduce((n, f) => n + gzipSync(f.contents).byteLength, 0),
  });
  const js = result.outputFiles.filter((f) => f.path.endsWith(".js"));
  const initial = size(js.filter((f) => f.path.endsWith(entry.replace(/^size\//, ""))));
  const lazy = size(js.filter((f) => !f.path.endsWith(entry.replace(/^size\//, ""))));
  const kib = (n) => (n / 1024).toFixed(1);
  console.log(
    `${label.padEnd(52)} ${kib(initial.bytes).padStart(6)} KiB min ${kib(initial.gzip).padStart(5)} KiB gzip` +
      `   + loaded on use: ${kib(lazy.bytes).padStart(5)} KiB min ${kib(lazy.gzip).padStart(5)} KiB gzip`,
  );
}

await measure("@gizmodata/warp-sql (apache-arrow, fzstd external)", ["apache-arrow", "fzstd"]);
await measure("with fzstd", ["apache-arrow"]);
await measure("with fzstd and apache-arrow", []);

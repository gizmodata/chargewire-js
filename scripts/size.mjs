// Prints the client's bundle size for browsers: the web build minified, without its
// peer dependency (apache-arrow) and the lazily loaded zstd decoder, then with both.
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

async function measure(label, external) {
  const result = await build({
    entryPoints: ["dist/web/index.mjs"],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2023",
    write: false,
    external,
    logLevel: "silent",
  });
  const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
  const gzip = result.outputFiles.reduce((n, f) => n + gzipSync(f.contents).byteLength, 0);
  console.log(
    `${label.padEnd(46)} ${(bytes / 1024).toFixed(1).padStart(7)} KiB min  ${(gzip / 1024).toFixed(1).padStart(6)} KiB gzip`,
  );
}

await measure("@gizmodata/warp-sql (apache-arrow, fzstd external)", ["apache-arrow", "fzstd"]);
await measure("with fzstd", ["apache-arrow"]);
await measure("with fzstd and apache-arrow", []);

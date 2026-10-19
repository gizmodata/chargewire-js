// Runs smoke.mjs under each runtime in WARP_SQL_JS_SMOKE_RUNTIMES (default: node,deno,bun,workerd;
// workerd runs worker.mjs in Cloudflare's runtime through Miniflare)
// against a server started from WARP_SQL_JS_TEST_SERVER_BINARY. A missing runtime, a
// missing server or a failed check fails the run. Needs a build (npm run build) and Node
// that runs TypeScript (22.18 or later), for the shared harness.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { launchServer } from "../live/harness.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("./smoke.mjs", import.meta.url));
const runtimes = (process.env.WARP_SQL_JS_SMOKE_RUNTIMES ?? "node,deno,bun,workerd").split(",").filter(Boolean);
const server = await launchServer();
const env = {
  ...process.env,
  WARP_SQL_JS_SMOKE_URL: `warp://${server.host}?tls=false`,
  WARP_SQL_JS_SMOKE_PASSWORD: server.password,
};
const commands = {
  node: ["node", [script]],
  bun: ["bun", [script]],
  // Deno resolves npm packages with the "deno" and "node" conditions, so it gets the Node build.
  deno: [
    "deno",
    ["run", "--allow-net", "--allow-env", "--allow-read", script],
    { WARP_SQL_JS_SMOKE_IMPORT: `${root}/dist/node/index.mjs` },
  ],
};
let failed = 0;
try {
  for (const name of runtimes) {
    if (name === "workerd") {
      try {
        console.log(await runWorker());
      } catch (err) {
        failed++;
        console.error(`FAIL workerd: ${err?.stack ?? err}`);
      }
      continue;
    }
    const [command, args, extra] = commands[name] ?? [];
    if (command === undefined) throw new Error(`unknown runtime ${name}`);
    const result = spawnSync(command, args, {
      cwd: root,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.error || result.status !== 0 || !output.includes("smoke ok")) {
      failed++;
      console.error(`FAIL ${name}: ${result.error?.message ?? `exit ${result.status}`}\n${output}`);
    } else {
      console.log(output);
    }
  }
} finally {
  await server.stop();
}
if (failed > 0) process.exit(1);

/** Bundles worker.mjs as wrangler would and runs it in workerd. */
async function runWorker() {
  const { build } = await import("esbuild");
  const { Miniflare } = await import("miniflare");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./worker.mjs", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    target: "es2023",
    write: false,
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-01",
    bindings: { WARP_URL: `http://${server.host}`, WARP_PASSWORD: server.password },
  });
  try {
    const resp = await mf.dispatchFetch("http://worker.test/");
    const text = await resp.text();
    const result = JSON.parse(text);
    if (
      result.rows !== 500000 ||
      result.first !== 499999 ||
      result.streamed !== 300000 ||
      result.code !== "sql_error" ||
      (result.lz4 !== "v299999" && result.lz4 !== "not offered")
    ) {
      throw new Error(`unexpected answer: ${text}`);
    }
    return `smoke ok: workerd (Cloudflare Workers runtime) ${JSON.stringify(result)}`;
  } finally {
    await mf.dispose();
  }
}

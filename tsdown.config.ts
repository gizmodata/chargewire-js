// Two builds of the same source: `node` (Node, Deno, Bun: TLS settings through undici,
// streaming uploads, 8 partitions) and `web` (browsers, edge runtimes). package.json's
// export conditions pick one. `#platform` is the only difference: each build's tsconfig
// maps it to its own file.
import { type UserConfig, defineConfig } from "tsdown";

const build = (name: "node" | "web"): UserConfig => ({
  entry: { index: "src/index.ts" },
  outDir: `dist/${name}`,
  format: ["esm", "cjs"],
  platform: name === "node" ? "node" : "neutral",
  target: "es2023",
  dts: true,
  sourcemap: true,
  clean: true,
  tsconfig: `tsconfig.${name}.json`,
  fixedExtension: true,
  deps: { neverBundle: ["apache-arrow", "fzstd", "undici"] },
});

export default defineConfig([build("node"), build("web")]);

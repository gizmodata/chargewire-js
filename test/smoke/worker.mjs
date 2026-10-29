// A Cloudflare Worker that uses the client: run.mjs bundles it the way wrangler does
// (export conditions "workerd", "worker", "browser") and runs it in workerd (Miniflare).
import { ChargewireError, connect } from "@gizmodata/chargewire";

export default {
  async fetch(_request, env) {
    const conn = await connect({
      url: env.CHARGEWIRE_URL,
      username: "chargewire_test",
      password: env.CHARGEWIRE_PASSWORD,
    });
    try {
      const table = await conn.query("SELECT i FROM range(500000) t(i) ORDER BY i DESC");
      // The LZ4 decoder is a lazily loaded module, bundled the way wrangler would.
      const lz4 = conn.capabilities.has("ipc_compression_lz4_frame")
        ? (
            await conn.query("SELECT 'v' || i AS s FROM range(300000) t(i) ORDER BY i", undefined, {
              ipcCompression: "lz4_frame",
            })
          ).get(299999).s
        : "not offered";
      let streamed = 0;
      for await (const batch of conn.stream("SELECT * FROM range(300000)")) streamed += batch.numRows;
      let code = "";
      try {
        await conn.query("SELEC 1");
      } catch (err) {
        code = err instanceof ChargewireError ? err.code : String(err);
      }
      return Response.json({ rows: table.numRows, first: Number(table.get(0).i), streamed, code, lz4 });
    } finally {
      await conn.close();
    }
  },
};

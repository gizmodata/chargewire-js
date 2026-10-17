// A Cloudflare Worker that uses the client: run.mjs bundles it the way wrangler does
// (export conditions "workerd", "worker", "browser") and runs it in workerd (Miniflare).
import { WarpSqlError, connect } from "@gizmodata/warp-sql";

export default {
  async fetch(_request, env) {
    const conn = await connect({ url: env.WARP_URL, username: "warp_test", password: env.WARP_PASSWORD });
    try {
      const table = await conn.query("SELECT i FROM range(500000) t(i) ORDER BY i DESC");
      let streamed = 0;
      for await (const batch of conn.stream("SELECT * FROM range(300000)")) streamed += batch.numRows;
      let code = "";
      try {
        await conn.query("SELEC 1");
      } catch (err) {
        code = err instanceof WarpSqlError ? err.code : String(err);
      }
      return Response.json({ rows: table.numRows, first: Number(table.get(0).i), streamed, code });
    } finally {
      await conn.close();
    }
  },
};

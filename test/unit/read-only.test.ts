import { expect, test } from "vitest";
import { connect, type ConnectOptions } from "../../src/index.js";
import { FakeServer, json, problem } from "./fake.js";

const sessions = /^\/chargewire\/v1\/sessions$/;
const open = (server: FakeServer, extra: Partial<ConnectOptions> = {}) =>
  connect({
    url: "chargewire://db.test:31337",
    username: "u",
    password: "p",
    fetch: server.fetch,
    logger: { warn: () => {} },
    ...extra,
  });

for (const confirmation of [undefined, false, "true", true]) {
  test(`creation requires boolean confirmation (${String(confirmation)})`, async () => {
    const server = new FakeServer();
    server.on("POST", sessions, () => json(201, { session_id: "s1", options: { read_only: confirmation } }));
    const promise = open(server, { sessionOptions: { read_only: true } });
    if (confirmation === true) {
      const conn = await promise;
      await expect(conn.setOptions({ read_only: false })).rejects.toMatchObject({ code: "read_only" });
      await conn.close();
    } else {
      await expect(promise).rejects.toThrow("confirm read_only=true");
      expect(server.count("DELETE", /\/sessions\/s1$/)).toBe(1);
    }
    const body = JSON.parse(
      server.requests.find((r) => r.method === "POST" && sessions.test(r.url.pathname))!.body,
    ) as { options: { read_only: unknown } };
    expect(body.options.read_only).toBe(true);
  });
}

test("lazy read-only is sent in creation, and cannot be downgraded", async () => {
  const server = new FakeServer();
  server.on("GET", /^\/chargewire$/, () =>
    json(200, {
      protocol: "chargewire",
      protocol_versions: ["1"],
      capabilities: [],
      auth: { grant_types: ["password"] },
      state: "stopped",
    }),
  );
  server.on("POST", sessions, (r) =>
    json(201, { session_id: "s1", options: (JSON.parse(r.body) as { options: unknown }).options }),
  );
  server.on("GET", /\/sessions\/s1$/, () => json(200, { session_id: "s1", options: { read_only: true } }));
  const conn = await open(server);
  await conn.setOptions({ read_only: true });
  await expect(conn.setOptions({ read_only: false })).rejects.toMatchObject({ code: "read_only" });
  expect(server.count("POST", sessions)).toBe(0);
  expect((await conn.getSession()).options?.["read_only"]).toBe(true);
  const creation = JSON.parse(server.requests.find((r) => sessions.test(r.url.pathname))!.body) as { options: unknown };
  expect(creation.options).toMatchObject({ read_only: true });
  expect(server.count("PATCH", /\/sessions\//)).toBe(0);
  await conn.close();
});

test("an ignored PATCH closes the connection", async () => {
  const server = new FakeServer();
  server.on("PATCH", /\/sessions\/s1$/, () => json(200, { options: {} }));
  const conn = await open(server);
  await expect(conn.setOptions({ read_only: true })).rejects.toThrow("confirm read_only=true");
  expect(conn.closed).toBe(true);
  await expect(conn.getSession()).rejects.toMatchObject({ code: "client_connection_closed" });
  expect(server.count("DELETE", /\/sessions\/s1$/)).toBe(1);
  await conn.close();
});

test("concurrent option changes cannot undo a confirmed restriction", async () => {
  const server = new FakeServer();
  server.on("PATCH", /\/sessions\/s1$/, (r) =>
    json(200, { options: (JSON.parse(r.body) as { options: unknown }).options }),
  );
  const conn = await open(server);
  const results = await Promise.allSettled([
    conn.setOptions({ read_only: true }),
    conn.setOptions({ read_only: false }),
  ]);
  expect(results[0]?.status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "read_only" } });
  expect(server.count("PATCH", /\/sessions\/s1$/)).toBe(1);
  await conn.close();
});

for (const confirmed of [true, false]) {
  test(`replacement replays server-imposed restriction and confirms it (${confirmed})`, async () => {
    const server = new FakeServer();
    let creates = 0;
    server.on("POST", sessions, (r) => {
      creates++;
      if (creates > 1) expect((JSON.parse(r.body) as { options: unknown }).options).toMatchObject({ read_only: true });
      return json(201, {
        session_id: `s${creates}`,
        options: creates === 1 || confirmed ? { read_only: true } : {},
        transaction: "none",
      });
    });
    server.on("GET", /\/sessions\/s1$/, () => problem(404, "session_not_found"));
    server.on("GET", /\/sessions\/s2$/, () => json(200, { session_id: "s2", options: { read_only: true } }));
    const conn = await open(server);
    if (confirmed) expect((await conn.getSession()).options?.["read_only"]).toBe(true);
    else {
      await expect(conn.getSession()).rejects.toThrow();
      expect(server.count("GET", /\/sessions\/s2$/)).toBe(0);
      expect(server.count("DELETE", /\/sessions\/s2$/)).toBe(1);
    }
    expect(creates).toBe(2);
    await conn.close();
  });
}

test("a delayed confirmation from the old session cannot cover its replacement", async () => {
  const server = new FakeServer();
  let release!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.on("PATCH", /\/sessions\/s1$/, async () => {
    arrived();
    await hold;
    return json(200, { options: { read_only: true } });
  });
  server.on("GET", /\/sessions\/s1$/, () => problem(404, "session_not_found"));
  server.on("GET", /\/sessions\/s2$/, () => json(200, { session_id: "s2", options: {} }));
  const conn = await open(server);
  const setting = conn.setOptions({ read_only: true });
  await waiting;
  try {
    await conn.getSession();
  } finally {
    release();
  }
  await expect(setting).rejects.toThrow("confirm read_only=true");
  await expect(conn.getSession()).rejects.toMatchObject({ code: "client_connection_closed" });
  await conn.close();
});

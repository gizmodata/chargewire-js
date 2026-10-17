import { describe, expect, test } from "vitest";

import { AsyncQueue } from "../../src/queue.js";
import { likeToRegExp } from "../../src/metadata.js";

describe("AsyncQueue", () => {
  test("holds producers back at capacity and ends when every producer closed", async () => {
    const queue = new AsyncQueue<number>(2, 2);
    let pushed = 0;
    const producer = async (start: number): Promise<void> => {
      for (let i = start; i < start + 5; i++) {
        await queue.push(i);
        pushed++;
      }
      queue.close();
    };
    const producers = [producer(0), producer(100)];
    await new Promise((r) => setTimeout(r, 10));
    expect(pushed).toBe(2); // the rest wait for room
    const got: number[] = [];
    for (let r = await queue.next(); !r.done; r = await queue.next()) got.push(r.value);
    await Promise.all(producers);
    expect(got.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 100, 101, 102, 103, 104]);
  });

  test("failing it wakes the consumer with the error and stops producers", async () => {
    const queue = new AsyncQueue<number>(1);
    await queue.push(1);
    const blocked = queue.push(2);
    queue.fail(new Error("boom"));
    expect(await blocked).toBe(false);
    await expect(queue.next()).rejects.toThrow("boom");
  });
});

describe("LIKE patterns (§10)", () => {
  test("% and _ match; \\ escapes; everything else is literal", () => {
    expect(likeToRegExp("par%").test("parent")).toBe(true);
    expect(likeToRegExp("par%").test("apart")).toBe(false);
    expect(likeToRegExp("a_c").test("abc")).toBe(true);
    expect(likeToRegExp("a\\_c").test("abc")).toBe(false);
    expect(likeToRegExp("a\\_c").test("a_c")).toBe(true);
    expect(likeToRegExp("a.c").test("abc")).toBe(false);
    expect(likeToRegExp("(x)+").test("(x)+")).toBe(true);
  });
});

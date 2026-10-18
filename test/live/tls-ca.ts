// Licensed under the Apache License, Version 2.0.

import { onTestFinished } from "vitest";

import { type TestCA, makeCAWithCleanup } from "./certs.js";

/** A throwaway CA (see certs.ts) whose files are deleted when the test ends. */
export function makeCA(): TestCA {
  const ca = makeCAWithCleanup();
  onTestFinished(() => ca.remove());
  return ca;
}

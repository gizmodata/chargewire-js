// Licensed under the Apache License, Version 2.0.

import { invalidArgument } from "../errors.js";
import type { Platform } from "./types.js";

/** Browsers and edge runtimes (Cloudflare Workers): plain fetch. */
export const platform: Platform = {
  name: "web",
  defaultResultPartitions: 4,
  streamingUploads: false,
  tlsFetch(): Promise<typeof fetch> {
    return Promise.reject(
      invalidArgument(
        "tls options apply in Node, Deno and Bun only; browsers and edge runtimes verify certificates with the platform's trust store",
      ),
    );
  },
};

// Licensed under the Apache License, Version 2.0.
//
// Connection strings saved before the protocol was renamed to Chargewire keep working: the
// old scheme (`warp://`) means `chargewire://`, and the old default base path (`/warp`) means
// `/chargewire`. The mapping is silent. This module and its tests are the only places the old
// spelling is written down.

import type { SchemeMap } from "./url.js";

const legacyScheme = "warp";
const currentScheme = "chargewire";
const legacyBasePath = "/warp";

/**
 * Rewrites a URL's old scheme to the current one, when the accepted schemes have the current
 * scheme and don't define the old one themselves. Anything else comes back unchanged.
 */
export function adoptLegacyScheme(raw: string, schemes: SchemeMap): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (match === null || match[1]!.toLowerCase() !== legacyScheme) return raw;
  if (Object.hasOwn(schemes, legacyScheme) || !Object.hasOwn(schemes, currentScheme)) return raw;
  return `${currentScheme}://${raw.slice(match[0].length)}`;
}

/**
 * The base path to use for a URL's path (trailing slashes already removed): the old default
 * base path becomes `current`, the current default; any other path is kept.
 */
export function adoptLegacyBasePath(path: string, current: string): string {
  return path === legacyBasePath ? current : path;
}

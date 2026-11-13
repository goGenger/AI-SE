import type { VisualInputRecord } from "@ai-se/shared";
import { VisualInputRecordSchema } from "@ai-se/shared";
import chromium from "playwright";
import type { PageLike, PlaywrightLike } from "./session";

/**
 * Phase 5.6-3: the ONLY file in @ai-se/browser that imports playwright
 * (prompt §五.1 — statically asserted). Everything else programs against the
 * interfaces in ./session.
 */

export function createRealPlaywright(): PlaywrightLike {
  return chromium;
}

/** 5.6-4 seam: screenshot assetRef + viewport → strict VisualInputRecord (§三.3). */
export function toVisualInputRecord(
  assetRef: string,
  viewport: { width: number; height: number }
): VisualInputRecord {
  return VisualInputRecordSchema.parse({
    inputType: "screenshot",
    source: assetRef,
    viewport
  });
}

export type { PageLike };

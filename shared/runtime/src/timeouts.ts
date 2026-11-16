import { z } from "zod";

// A slow environment multiplies every limit a Spec run waits for, so the Specs keep the default waits.
export const MAX_TIMEOUT_SCALE = 5;
export const timeoutScaleSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_SCALE);

export function specTimeouts(scale = 1) {
  return {
    test: 100_000 * scale,
    navigation: 30_000 * scale,
    action: 15_000 * scale,
    expect: 5_000 * scale,
  };
}

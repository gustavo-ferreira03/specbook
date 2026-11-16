/** Fail at an invariant boundary instead of trusting a non-null assertion. */
export const requireValue = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    throw new Error("An expected value is missing.");
  }
  return value;
};

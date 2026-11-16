/** Assert a value that was promised by a validated response or earlier check. */
export const requiredValue = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    throw new Error("An expected command value is missing");
  }
  return value;
};

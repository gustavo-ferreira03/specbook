export const requiredValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected an existing value");
  }
  return value;
};

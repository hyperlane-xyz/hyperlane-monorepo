export function assert<T>(
  predicate: T,
  errorMessage: string,
): asserts predicate {
  if (!predicate) {
    throw new Error(errorMessage);
  }
}

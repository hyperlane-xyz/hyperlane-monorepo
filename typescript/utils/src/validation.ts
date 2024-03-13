export function assert<T>(
  predicate: T,
  errorMessage?: string,
): asserts predicate is NonNullable<T> {
  if (!predicate) {
    throw new Error(errorMessage ?? 'Error');
  }
}

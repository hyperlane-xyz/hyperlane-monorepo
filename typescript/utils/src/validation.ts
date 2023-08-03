export function assert(predicate: any, errorMessage?: string) {
  if (!predicate) {
    throw new Error(errorMessage ?? 'Error');
  }
}

// TODO move to utils package

// Returns a \ b
// Taken from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set#implementing_basic_set_operations
export function setDifference<T>(a: Set<T>, b: Set<T>) {
  const diff = new Set(a);
  for (const element of b) {
    diff.delete(element);
  }
  return diff;
}

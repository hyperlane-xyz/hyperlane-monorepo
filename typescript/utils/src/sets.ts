// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set#implementing_basic_set_operations
export function difference<T>(a: Set<T>, b: Set<T>) {
  const _difference = new Set(a);
  for (const elem of b) {
    _difference.delete(elem);
  }
  return _difference;
}

export function symmetricDifference<T>(a: Set<T>, b: Set<T>) {
  const _difference = new Set(a);
  for (const elem of b) {
    if (_difference.has(elem)) {
      _difference.delete(elem);
    } else {
      _difference.add(elem);
    }
  }
  return _difference;
}

export function setEquality<T>(a: Set<T>, b: Set<T>) {
  return symmetricDifference(a, b).size === 0;
}

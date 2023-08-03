export function isNullish<T>(val: T) {
  if (val === null || val === undefined) return true;
  else return false;
}

export function isNumeric(value: string | number) {
  return typeof value === 'number' || /^\d+$/.test(value);
}

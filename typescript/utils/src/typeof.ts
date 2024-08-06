export function isNullish<T>(
  val: T,
): val is T extends null | undefined ? T : never {
  return val === null || val === undefined;
}

export function isNumeric(value: string | number) {
  return typeof value === 'number' || /^\d+$/.test(value);
}

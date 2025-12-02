export function logTable<T extends Record<string, any>>(
  data: T[],
  keys?: (keyof T)[],
) {
  return console.table(data, keys as string[]);
}

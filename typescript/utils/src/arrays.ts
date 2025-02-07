import { randomInt } from './math.js';

interface Sliceable {
  length: number;
  slice: (i: number, j: number) => any;
}

export function chunk<T extends Sliceable>(str: T, size: number) {
  const R: Array<T> = [];
  for (let i = 0; i < str.length; i += size) {
    R.push(str.slice(i, i + size));
  }
  return R;
}

export function exclude<T>(item: T, list: T[]) {
  return list.filter((i) => i !== item);
}

export function randomElement<T>(list: T[]) {
  return list[randomInt(list.length)];
}

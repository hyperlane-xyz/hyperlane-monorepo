import { sortBy } from 'lodash-es';

import { randomInt } from './math.js';
import { assert } from './validation.js';

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

export function sortArrayByKey<T extends Record<keyof T, any>>(
  array: T[],
  sortKey: keyof T,
): T[] {
  return sortBy(array, [(item) => item[sortKey]]);
}

// Validates that 2 arrays are equal in both ordering and elements
export function arrayEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((item, idx) => item === b[idx]);
}

/** Non-empty tuple type — at least one element required at compile time. */
export type NonEmptyArray<T> = readonly [T, ...T[]];

export function isNonEmptyArray<T>(arr: readonly T[]): arr is NonEmptyArray<T> {
  return arr.length > 0;
}

export function nonEmptyArray<T>(arr: readonly T[]): NonEmptyArray<T> {
  assert(isNonEmptyArray(arr), 'expected non-empty array');
  return arr;
}

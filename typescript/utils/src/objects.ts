import { cloneDeep, isEqual } from 'lodash-es';
import { stringify as yamlStringify } from 'yaml';

import { ethersBigNumberSerializer } from './logging.js';
import { isNullish } from './typeof.js';
import { assert } from './validation.js';

export function isObject(item: any) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

export function deepEquals(v1: any, v2: any) {
  return isEqual(v1, v2);
}

export function deepCopy(v: any) {
  return cloneDeep(v);
}

export type ValueOf<T> = T[keyof T];

// Useful for maintaining type safety when using Object.keys
export function objKeys<T extends string | number>(obj: Record<T, any>): T[] {
  return Object.keys(obj) as T[];
}

export function objLength(obj: Record<any, any>) {
  return Object.keys(obj).length;
}

export function isObjEmpty(obj: Record<any, any>) {
  return objLength(obj) === 0;
}

export function objMapEntries<
  M extends Record<K, I>,
  K extends keyof M,
  O,
  I = ValueOf<M>,
>(obj: M, func: (k: K, v: I) => O): [K, O][] {
  return Object.entries<I>(obj).map(([k, v]) => [k as K, func(k as K, v)]);
}

// Map over the values of the object
export function objMap<
  M extends Record<K, I>,
  K extends keyof M,
  O,
  I = ValueOf<M>,
>(obj: M, func: (k: K, v: I) => O): Record<K, O> {
  return Object.fromEntries<O>(objMapEntries(obj, func)) as Record<K, O>;
}

export function objFilter<K extends string, I, O extends I>(
  obj: Record<K, I>,
  func: (k: K, v: I) => v is O,
): Record<K, O> {
  return Object.fromEntries(
    Object.entries<I>(obj).filter(([k, v]) => func(k as K, v)),
  ) as Record<K, O>;
}

export function deepFind<I extends object, O extends I>(
  obj: I,
  func: (v: I) => v is O,
  depth = 10,
): O | undefined {
  assert(depth > 0, 'deepFind max depth reached');
  if (func(obj)) {
    return obj;
  }
  const entries = isObject(obj)
    ? Object.values(obj)
    : Array.isArray(obj)
    ? obj
    : [];
  return entries.map((e) => deepFind(e as any, func, depth - 1)).find((v) => v);
}

// promiseObjectAll :: {k: Promise a} -> Promise {k: a}
export function promiseObjAll<K extends string, V>(obj: {
  [key in K]: Promise<V>;
}): Promise<Record<K, V>> {
  const promiseList = Object.entries(obj).map(([name, promise]) =>
    (promise as Promise<V>).then((result) => [name, result]),
  );
  return Promise.all(promiseList).then(Object.fromEntries);
}

// Get the subset of the object from key list
export function pick<K extends string, V = any>(obj: Record<K, V>, keys: K[]) {
  const ret: Partial<Record<K, V>> = {};
  const objKeys = Object.keys(obj);
  for (const key of keys) {
    if (objKeys.includes(key)) {
      ret[key] = obj[key];
    }
  }
  return ret as Record<K, V>;
}

// Recursively merges b into a
// Where there are conflicts, b takes priority over a
export function objMerge(
  a: Record<string, any>,
  b: Record<string, any>,
  max_depth = 10,
): any {
  if (max_depth === 0) {
    throw new Error('objMerge tried to go too deep');
  }
  if (isObject(a) && isObject(b)) {
    const ret: Record<string, any> = {};
    const aKeys = new Set(Object.keys(a));
    const bKeys = new Set(Object.keys(b));
    const allKeys = new Set([...aKeys, ...bKeys]);
    for (const key of allKeys.values()) {
      if (aKeys.has(key) && bKeys.has(key)) {
        ret[key] = objMerge(a[key], b[key], max_depth - 1);
      } else if (aKeys.has(key)) {
        ret[key] = a[key];
      } else {
        ret[key] = b[key];
      }
    }
    return ret;
  } else {
    return b ? b : a;
  }
}

export function invertKeysAndValues(data: any) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [value, key]),
  );
}

// Returns an object with the keys as values from an array and value set to true
export function arrayToObject(keys: Array<string>, val = true) {
  return keys.reduce<Record<string, boolean>>((result, k) => {
    result[k] = val;
    return result;
  }, {});
}

export function stringifyObject(
  object: any,
  format: 'json' | 'yaml' = 'yaml',
  space?: number,
): string {
  // run through JSON first because ethersBigNumberSerializer does not play nice with yamlStringify
  // so we fix up in JSON, then parse and if required return yaml on processed JSON after
  const json = JSON.stringify(object, ethersBigNumberSerializer, space);
  if (format === 'json') {
    return json;
  }
  return yamlStringify(JSON.parse(json), null, space);
}

interface ObjectDiffOutput {
  actual: any;
  expected: any;
}

export type ObjectDiff =
  | {
      [key: string]: ObjectDiffOutput | ObjectDiff;
    }
  | ObjectDiff[];

/**
 * Merges 2 objects showing any difference in value for common fields.
 */
export function diffObjMerge(
  actual: Record<string, any>,
  expected: Record<string, any>,
  max_depth = 10,
): {
  mergedObject: ObjectDiff;
  isInvalid: boolean;
} {
  if (max_depth === 0) {
    throw new Error('diffObjMerge tried to go too deep');
  }

  let isDiff = false;
  if (!isObject(actual) && !isObject(expected) && actual === expected) {
    return {
      isInvalid: isDiff,
      mergedObject: actual,
    };
  }

  if (isObject(actual) && isObject(expected)) {
    const ret: Record<string, ObjectDiff> = {};

    const actualKeys = new Set(Object.keys(actual));
    const expectedKeys = new Set(Object.keys(expected));
    const allKeys = new Set([...actualKeys, ...expectedKeys]);
    for (const key of allKeys.values()) {
      if (actualKeys.has(key) && expectedKeys.has(key)) {
        const { mergedObject, isInvalid } = diffObjMerge(
          actual[key],
          expected[key],
          max_depth - 1,
        );
        ret[key] = mergedObject;
        isDiff ||= isInvalid;
      } else if (actualKeys.has(key) && !isNullish(actual[key])) {
        ret[key] = {
          actual: actual[key],
          expected: '' as any,
        };
      } else if (!isNullish(expected[key])) {
        ret[key] = {
          actual: '' as any,
          expected: expected[key],
        };
      }
    }
    return {
      isInvalid: isDiff,
      mergedObject: ret,
    };
  }

  // Merge the elements of the array to see if there are any differences
  if (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length
  ) {
    const merged = actual.reduce(
      (acc: [ObjectDiff[], boolean], curr, idx) => {
        const { isInvalid, mergedObject } = diffObjMerge(curr, expected[idx]);

        acc[0].push(mergedObject);
        acc[1] ||= isInvalid;

        return acc;
      },
      [[], isDiff],
    );
    return {
      isInvalid: merged[1],
      mergedObject: merged[0],
    };
  }

  return {
    mergedObject: { expected: expected ?? '', actual: actual ?? '' },
    isInvalid: true,
  };
}

import { cloneDeep, isEqual } from 'lodash-es';
import { stringify as yamlStringify } from 'yaml';

import { ethersBigNumberSerializer } from './logging.js';
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

/**
 *  Returns a new object that recursively merges B into A
 *  Where there are conflicts, B takes priority over A
 *  If B has a value for a key that A does not have, B's value is used
 *  If B has a value for a key that A has, and both are objects, the merge recurses into those objects
 *  If B has a value for a key that A has, and both are arrays, the merge concatenates them with B's values taking priority
 * @param a - The first object
 * @param b - The second object
 * @param max_depth - The maximum depth to recurse
 * @param mergeArrays - If true, arrays will be concatenated instead of replaced
 */
export function objMerge<T = any>(
  a: Record<string, any>,
  b: Record<string, any>,
  max_depth = 10,
  mergeArrays = false,
): T {
  // If we've reached the max depth, throw an error
  if (max_depth === 0) {
    throw new Error('objMerge tried to go too deep');
  }
  // If either A or B is not an object, return the other value
  if (!isObject(a) || !isObject(b)) {
    return (b ?? a) as T;
  }
  // Initialize returned object with values from A
  const ret: Record<string, any> = { ...a };
  // Iterate over keys in B
  for (const key in b) {
    // If both A and B have the same key, recursively merge the values from B into A
    if (isObject(a[key]) && isObject(b[key])) {
      ret[key] = objMerge(a[key], b[key], max_depth - 1, mergeArrays);
    }
    // If A & B are both arrays, and we're merging them, concatenate them with B's values taking priority before A
    else if (mergeArrays && Array.isArray(a[key]) && Array.isArray(b[key])) {
      ret[key] = [...b[key], ...a[key]];
    }
    // If B has a value for the key, set the value to B's value
    // This better handles the case where A has a value for the key, but B does not
    // In which case we want to keep A's value
    else if (b[key] !== undefined) {
      ret[key] = b[key];
    }
  }
  // Return the merged object
  return ret as T;
}

/**
 * Return a new object with the fields in b removed from a
 * @param a Base object to remove fields from
 * @param b The partial object to remove from the base object
 * @param max_depth The maximum depth to recurse
 * @param sliceArrays If true, arrays will have values sliced out instead of being removed entirely
 */
export function objOmit<T extends Record<string, any> = any>(
  a: Record<string, any>,
  b: Record<string, any>,
  max_depth = 10,
  sliceArrays = false,
): T {
  if (max_depth === 0) {
    throw new Error('objSlice tried to go too deep');
  }
  if (!isObject(a) || !isObject(b)) {
    return a as T;
  }
  const ret: Record<string, any> = {};
  const aKeys = new Set(Object.keys(a));
  const bKeys = new Set(Object.keys(b));
  for (const key of aKeys.values()) {
    if (bKeys.has(key)) {
      if (sliceArrays && Array.isArray(a[key]) && Array.isArray(b[key])) {
        ret[key] = a[key].filter(
          (v: any) => !b[key].some((bv: any) => deepEquals(v, bv)),
        );
      } else if (isObject(a[key]) && isObject(b[key])) {
        const sliced = objOmit(a[key], b[key], max_depth - 1, sliceArrays);
        if (Object.keys(sliced).length > 0) {
          ret[key] = sliced;
        }
      } else if (!!b[key] == false) {
        ret[key] = objOmit(a[key], b[key], max_depth - 1, sliceArrays);
      }
    } else {
      ret[key] = a[key];
    }
  }
  return ret as T;
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

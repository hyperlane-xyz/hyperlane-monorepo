// TODO move to utils package

export function objMapEntries<K extends string, I = any, O = any>(
  obj: Record<K, I>,
  func: (k: K, _: I) => O,
): [K, O][] {
  return Object.entries<I>(obj).map(([k, v]) => [k as K, func(k as K, v)]);
}

// Map over the values of the object
export function objMap<K extends string, I = any, O = any>(
  obj: Record<K, I>,
  func: (k: K, _: I) => O,
) {
  return Object.fromEntries<O>(objMapEntries<K, I, O>(obj, func)) as Record<
    K,
    O
  >;
}

// Similar to objMap above but supports objects with 'Partial' types
export function partialObjMap<K extends string, I = any, O = any>(
  obj: Partial<Record<K, I>>,
  func: (k: K, _: I) => O,
) {
  const keys = Object.keys(obj) as K[];
  return keys.reduce<Partial<Record<K, O>>>((result, key) => {
    result[key] = func(key, obj[key]!);
    return result;
  }, {});
}

// promiseObjectAll :: {k: Promise a} -> Promise {k: a}
export const promiseObjAll = <K extends string, V>(object: {
  [key in K]: Promise<V>;
}): Promise<Record<K, V>> => {
  const promiseList = Object.entries(object).map(([name, promise]) =>
    (promise as Promise<V>).then((result) => [name, result]),
  );
  return Promise.all(promiseList).then(Object.fromEntries);
};

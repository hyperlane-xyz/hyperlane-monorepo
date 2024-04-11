/**
 * Map an async function over a list xs with a given concurrency level
 * Forked from https://github.com/celo-org/developer-tooling/blob/0c61e7e02c741fe10ecd1d733a33692d324cdc82/packages/sdk/base/src/async.ts#L128
 *
 * @param concurrency number of `mapFn` concurrent executions
 * @param xs list of value
 * @param mapFn mapping function
 */
export async function concurrentMap<A, B>(
  concurrency: number,
  xs: A[],
  mapFn: (val: A, idx: number) => Promise<B>,
): Promise<B[]> {
  let res: B[] = [];
  for (let i = 0; i < xs.length; i += concurrency) {
    const remaining = xs.length - i;
    const sliceSize = Math.min(remaining, concurrency);
    const slice = xs.slice(i, i + sliceSize);
    res = res.concat(
      await Promise.all(slice.map((elem, index) => mapFn(elem, i + index))),
    );
  }
  return res;
}

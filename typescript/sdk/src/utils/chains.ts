import type { ChainMap } from '../types';

export function inferChainMap<M>(map: M) {
  return map as M extends ChainMap<infer Chain, infer Value>
    ? Record<Chain, Value>
    : never;
}

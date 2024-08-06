import { ChainMap } from '../types.js';

export function filterByChains<T>(
  owners: ChainMap<T>,
  filterByChainName: Set<string>,
): ChainMap<T> {
  return Object.keys(owners).reduce((result, chain) => {
    if (filterByChainName.has(chain)) {
      result[chain] = owners[chain];
    }
    return result;
  }, {} as ChainMap<T>);
}

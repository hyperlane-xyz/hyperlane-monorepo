import { ChainMap } from '@hyperlane-xyz/sdk';

export function filteredOwners(
  owners: ChainMap<string>,
  filterByChainName: Set<string>,
): ChainMap<string> {
  return Object.keys(owners).reduce((result, chain) => {
    if (filterByChainName.has(chain)) {
      result[chain] = owners[chain];
    }
    return result;
  }, {} as ChainMap<string>);
}

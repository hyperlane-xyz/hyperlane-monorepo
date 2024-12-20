import { AddressesMap, ChainMap } from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { getMainnetAddresses } from '../../../registry.js';

export function getInterchainAccountRouters(): ChainMap<{ router: Address }> {
  const coreAddresses: ChainMap<AddressesMap> = getMainnetAddresses();
  const filteredAddresses = objFilter(
    coreAddresses,
    (_, addressMap): addressMap is AddressesMap =>
      addressMap.interchainAccountRouter !== undefined,
  );
  return objMap(filteredAddresses, (_, addressMap) => ({
    router: addressMap.interchainAccountRouter,
  }));
}

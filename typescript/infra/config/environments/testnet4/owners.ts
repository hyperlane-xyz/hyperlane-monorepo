import { alfajores, plumetestnet } from '@hyperlane-xyz/registry';
import { AddressesMap, ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap, objMerge } from '@hyperlane-xyz/utils';

import { getTestnetAddresses } from '../../registry.js';

import { ethereumChainNames } from './chains.js';

const ETHEREUM_DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
// const SEALEVEL_DEPLOYER_ADDRESS = '6DjHX6Ezjpq3zZMZ8KsqyoFYo1zPSDoiZmLLkxD4xKXS';

export function localICARouters(): ChainMap<Address> {
  const coreAddresses: ChainMap<AddressesMap> = getTestnetAddresses();
  const filteredAddresses = objFilter(
    coreAddresses,
    (_, addressMap): addressMap is AddressesMap =>
      addressMap.interchainAccountRouter !== undefined,
  );
  return objMap(
    filteredAddresses,
    (_, addressMap) => addressMap.interchainAccountRouter,
  );
}

// const localRouters = localICARouters();
// const hubChain = 'sepolia';

// function getICAOwnerConfig(chain: string): OwnableConfig {
//   return {

//   }
// }

// owner: {origin: <HUB_CHAIN>, owner: <SAFE_ADDRESS>, localRouter: localRouters[chain]}

export const owners: ChainMap<OwnableConfig> = objMerge(
  {
    ...Object.fromEntries(
      ethereumChainNames.map((chain) => [
        chain,
        { owner: ETHEREUM_DEPLOYER_ADDRESS },
      ]),
    ),
    // [chainMetadata.solanadevnet.name]: SEALEVEL_DEPLOYER_ADDRESS,
  },
  {
    // alfajores: {
    //   ownerOverrides: {
    //     synthetic: "0xb8c49ef544c43d3842d693a61fc99911f22b1453",
    //   }
    // }
  },
);

console.log('owners', owners);

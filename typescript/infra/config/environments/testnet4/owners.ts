import { ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';
import { objMerge } from '@hyperlane-xyz/utils';

import { ethereumChainNames } from './chains.js';

const ETHEREUM_DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
// const SEALEVEL_DEPLOYER_ADDRESS = '6DjHX6Ezjpq3zZMZ8KsqyoFYo1zPSDoiZmLLkxD4xKXS';

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
    alfajores: {
      // ICA owned by the deployer on Sepolia.
      // $ cast call 0xEbA64c8a9b4a61a9210d5fe7E4375380999C821b 'getDeployedInterchainAccount(uint32,address,address,address)(address)' --rpc-url $(rpc alfajores) 11155111 0xfaD1C94469700833717Fa8a3017278BC1cA8031C 0x8e131c8aE5BF1Ed38D05a00892b6001a7d37739d $(cast az)
      // 0xB8C49EF544c43d3842D693a61fc99911f22B1453
      // owner: '0xb8c49ef544c43d3842d693a61fc99911f22b1453',
    },
  },
);

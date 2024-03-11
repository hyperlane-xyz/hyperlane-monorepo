import { ChainMap, OwnableConfig, chainMetadata } from '@hyperlane-xyz/sdk';

import { supportedChainNames } from '../testnet4/chains';

const ETHEREUM_DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
const SEPOLIA_SAFE_GOVERNOR = '0xCE6C85BF67566990dc69fD7e3760fed7b4a0dF21';
// const SEALEVEL_DEPLOYER_ADDRESS = '6DjHX6Ezjpq3zZMZ8KsqyoFYo1zPSDoiZmLLkxD4xKXS';

const localRouters = {
  [chainMetadata.plumetestnet.name]:
    '0xA0aB1750b4F68AE5E8C42d936fa78871eae52643',
  [chainMetadata.scrollsepolia.name]:
    '0x062dF6670d8F4E1dB8C1caaFf590e9c290147bba',
};

export const owners: ChainMap<OwnableConfig> = {
  ...Object.fromEntries(
    supportedChainNames.map((chain) => [
      chain,
      {
        owner: {
          origin: 'sepolia',
          owner: SEPOLIA_SAFE_GOVERNOR,
          localRouter: localRouters[chain],
        },
      },
    ]),
  ),
  [chainMetadata.sepolia.name]: { owner: ETHEREUM_DEPLOYER_ADDRESS },
  // [chainMetadata.solanadevnet.name]: SEALEVEL_DEPLOYER_ADDRESS,
};

export const beneficiaries: ChainMap<OwnableConfig> = {
  ...Object.fromEntries(
    supportedChainNames.map((chain) => [
      chain,
      {
        owner: ETHEREUM_DEPLOYER_ADDRESS,
      },
    ]),
  ),
  // [chainMetadata.solanadevnet.name]: SEALEVEL_DEPLOYER_ADDRESS,
};

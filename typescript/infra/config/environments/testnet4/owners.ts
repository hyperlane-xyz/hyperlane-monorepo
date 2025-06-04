import { ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';

import { ethereumChainNames } from './chains.js';

const ETHEREUM_DEPLOYER_ADDRESS = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';

// const SEALEVEL_DEPLOYER_ADDRESS = '6DjHX6Ezjpq3zZMZ8KsqyoFYo1zPSDoiZmLLkxD4xKXS';

export const owners: ChainMap<OwnableConfig> = {
  ...Object.fromEntries(
    ethereumChainNames.map((chain) => [
      chain,
      { owner: ETHEREUM_DEPLOYER_ADDRESS },
    ]),
  ),
  // [chainMetadata.solanadevnet.name]: SEALEVEL_DEPLOYER_ADDRESS,
  eclipsetestnet: {
    owner: 'n/a - SVM not supported here',
  },
  solanatestnet: {
    owner: 'n/a - SVM not supported here',
  },
  sonicsvmtestnet: {
    owner: 'n/a - SVM not supported here',
  },
  kyvetestnet: {
    owner: 'n/a - CSDK not supported here',
  },
  milkywaytestnet: {
    owner: 'n/a - CSDK not supported here',
  },
  nobletestnet: {
    owner: 'n/a - CSDK not supported here',
  },
  starknetsepolia: {
    owner: 'n/a - Starknet not supported here',
  },
  paradexsepolia: {
    owner: 'n/a - Starknet not supported here',
  },
};

export const ethereumChainOwners: ChainMap<OwnableConfig> = Object.fromEntries(
  Object.entries(owners).filter(([chain]) =>
    ethereumChainNames.includes(chain as any),
  ),
);

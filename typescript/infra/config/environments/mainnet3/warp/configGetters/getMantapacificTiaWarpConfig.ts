import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getMantapacificTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const neutronRouter =
    '0xc5fc6899019cb4a7649981d89eb7b1a0929d0a85b2d41802f3315129ad4b581a';

  // @ts-ignore - foreignDeployment configs don't conform to the HypTokenRouterConfig
  const neutron: HypTokenRouterConfig = {
    foreignDeployment: neutronRouter,
    owner: abacusWorksEnvOwnerConfig.neutron.owner,
    type: TokenType.native,
    decimals: 6,
    gas: 0,
  };

  const celestia: HypTokenRouterConfig = {
    ...routerConfig.celestia,
    ...abacusWorksEnvOwnerConfig.celestia,
    type: TokenType.collateral,
    name: 'TIA',
    symbol: 'TIA',
    token: 'utia',
    decimals: 6,
  };

  const mantapacific: HypTokenRouterConfig = {
    ...routerConfig.mantapacific,
    ...abacusWorksEnvOwnerConfig.mantapacific,
    type: TokenType.synthetic,
    name: 'TIA',
    symbol: 'TIA',
    decimals: 6,
    gas: 600_000,
    remoteRouters: {
      celestia: {
        address:
          '0x726f757465725f61707000000000000000000000000000010000000000000007',
      },
      neutron: {
        address: neutronRouter,
      },
    },
  };

  return {
    mantapacific,
    neutron,
  };
};

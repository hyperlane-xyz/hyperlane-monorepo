import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getMantapacificNeutronTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const neutronRouter =
    '0xc5fc6899019cb4a7649981d89eb7b1a0929d0a85b2d41802f3315129ad4b581a';

  // @ts-ignore - foreignDeployment configs don't conform to the HypTokenRouterConfig
  const neutron: HypTokenRouterConfig = {
    foreignDeployment: neutronRouter,
  };

  const mantapacific: HypTokenRouterConfig = {
    ...routerConfig.mantapacific,
    ...abacusWorksEnvOwnerConfig.mantapacific,
    type: TokenType.synthetic,
    name: 'TIA',
    symbol: 'TIA',
    decimals: 6,
    gas: 600_000,
  };

  return {
    mantapacific,
    neutron,
  };
};

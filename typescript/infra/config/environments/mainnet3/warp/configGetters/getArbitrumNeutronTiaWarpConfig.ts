import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getArbitrumNeutronTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const neutronRouter =
    '910926c4cf95d107237a9cf0b3305fe9c81351ebcba3d218ceb0e4935d92ceac';

  // @ts-ignore fix todo
  const neutron: TokenRouterConfig = {
    ...routerConfig.neutron,
    ...abacusWorksEnvOwnerConfig.neutron,
    foreignDeployment: neutronRouter,
  };

  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...abacusWorksEnvOwnerConfig.arbitrum,
    type: TokenType.synthetic,
    name: 'TIA',
    symbol: 'TIA.n',
    decimals: 6,
    totalSupply: 0,
    gas: 600_000,
  };

  return {
    arbitrum,
    neutron,
  };
};

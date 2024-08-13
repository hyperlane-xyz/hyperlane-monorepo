import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getMantapacificNeutronTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const neutronRouter =
    '0xc5fc6899019cb4a7649981d89eb7b1a0929d0a85b2d41802f3315129ad4b581a';

  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const neutron: TokenRouterConfig = {
    foreignDeployment: neutronRouter,
  };

  const mantapacific: TokenRouterConfig = {
    ...routerConfig.mantapacific,
    type: TokenType.synthetic,
    name: 'TIA',
    symbol: 'TIA',
    decimals: 6,
    totalSupply: 0,
    gas: 600_000,
  };

  return {
    mantapacific,
    neutron,
  };
};

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getArbitrumNeutronTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const neutronRouter =
    '910926c4cf95d107237a9cf0b3305fe9c81351ebcba3d218ceb0e4935d92ceac';

  // @ts-ignore - foreignDeployment configs dont conform to the TokenRouterConfig
  const neutron: TokenRouterConfig = {
    foreignDeployment: neutronRouter,
  };

  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
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

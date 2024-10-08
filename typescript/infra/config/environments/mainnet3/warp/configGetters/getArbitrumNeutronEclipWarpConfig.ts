import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getArbitrumNeutronEclipWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const neutronRouter =
    '6b04c49fcfd98bc4ea9c05cd5790462a39537c00028333474aebe6ddf20b73a3';

  // @ts-ignore - foreignDeployment configs dont conform to the TokenRouterConfig
  const neutron: TokenRouterConfig = {
    foreignDeployment: neutronRouter,
  };

  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
    type: TokenType.synthetic,
    name: 'Eclipse Fi',
    symbol: 'ECLIP',
    decimals: 6,
    totalSupply: 0,
    gas: 600_000,
    interchainSecurityModule: '0x53a5c239d62ff35c98e0ec9612c86517748fff59', // TODO: we should replace this with an ISM config
  };

  return {
    neutron,
    arbitrum,
  };
};

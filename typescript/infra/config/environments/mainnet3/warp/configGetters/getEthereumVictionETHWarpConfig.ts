import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

export const getEthereumVictionETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ismConfig = buildAggregationIsmConfigs(
    'ethereum',
    ['viction'],
    defaultMultisigConfigs,
  ).viction;

  const viction: TokenRouterConfig = {
    ...routerConfig.viction,
    type: TokenType.synthetic,
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
    totalSupply: 0,
    gas: 50_000,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.native,
    gas: 65_000,
    interchainSecurityModule: ismConfig,
  };

  return {
    viction,
    ethereum,
  };
};

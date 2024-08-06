import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getEthereumVictionUSDTWarpConfig = async (
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
    name: 'USDT',
    symbol: 'USDT',
    decimals: 6,
    totalSupply: 0,
    gas: 75_000,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    gas: 65_000,
    interchainSecurityModule: ismConfig,
  };

  return {
    viction,
    ethereum,
  };
};

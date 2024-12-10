import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getEthereumVictionUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ismConfig = buildAggregationIsmConfigs(
    'ethereum',
    ['viction'],
    defaultMultisigConfigs,
  ).viction;

  const viction: HypTokenRouterConfig = {
    ...routerConfig.viction,
    ...abacusWorksEnvOwnerConfig.viction,
    type: TokenType.synthetic,
    name: 'USDT',
    symbol: 'USDT',
    decimals: 6,
    totalSupply: 0,
    gas: 75_000,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
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

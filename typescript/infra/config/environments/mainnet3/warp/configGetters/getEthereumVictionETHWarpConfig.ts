import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getEthereumVictionETHWarpConfig = async (
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
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
    totalSupply: 0,
    gas: 50_000,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.native,
    gas: 65_000,
    interchainSecurityModule: ismConfig,
  };

  return {
    viction,
    ethereum,
  };
};

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  OwnableConfig,
  RoutingIsmConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const getIsm = (local: keyof typeof owners): RoutingIsmConfig => {
  return {
    type: IsmType.FALLBACK_ROUTING,
    owner: owners[local],
    domains: buildAggregationIsmConfigs(
      local,
      ['radix'],
      defaultMultisigConfigs,
    ),
  };
};

const owners = {
  ethereum: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  arbitrum: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  base: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  bnb: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  radix: 'account_rdx1280taxhhnuek02y59yapsg4kjtux954qkyufpwmy4dlfcxdrjzr7fj',
};

export const getArbitrumBaseEthereumRadixUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfig = getUSDCRebalancingBridgesConfigFor(
    Object.keys(owners),
  );

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    decimals: 6,
    interchainSecurityModule: getIsm('ethereum'),
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    ...rebalancingConfig.ethereum,
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    decimals: 6,
    interchainSecurityModule: getIsm('arbitrum'),
    owner: owners.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    ...rebalancingConfig.arbitrum,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    decimals: 6,
    interchainSecurityModule: getIsm('base'),
    owner: owners.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    ...rebalancingConfig.base,
  };

  const radix: HypTokenRouterConfig = {
    ...routerConfig.radix,
    owner: owners.radix,
    type: TokenType.synthetic,
    symbol: 'hUSDC',
    name: 'Hyperlane USD Coin',
    gas: 30_000_000,
    decimals: 6,
  };

  return {
    arbitrum,
    base,
    ethereum,
    radix,
  };
};

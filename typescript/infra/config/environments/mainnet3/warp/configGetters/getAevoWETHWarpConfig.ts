import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { AEVO_PROD_OWNERS, AEVO_STAGING_OWNERS, AevoOwners } from './aevo.js';
import { getCollateralTokenConfigForChain } from './utils.js';

const WETH_COLLATERAL_BY_CHAIN: ChainMap<Address> = {
  optimism: tokens.optimism.WETH,
  arbitrum: tokens.arbitrum.WETH,
  base: tokens.base.WETH,
};

// Aevo WETH: HypXERC20 over the existing Aevo token + collateral legs on the origin chains.
// Staging and prod share the structure; only owners differ.
// Origin legs deliberately set no allowedRebalancers / allowedRebalancingBridges: WETH is
// rebalanced off-chain by the rebalancer service (inventory execution via the LiFi external
// bridge + transferRemote), which needs no on-chain bridge allowlist.
function buildAevoWETHWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: AevoOwners,
): ChainMap<HypTokenRouterConfig> {
  return {
    aevo: {
      type: TokenType.XERC20,
      token: tokens.aevo.WETH,
      mailbox: routerConfig.aevo.mailbox,
      owner: ownersByChain.aevo,
    },
    optimism: getCollateralTokenConfigForChain(
      'optimism',
      routerConfig,
      ownersByChain,
      WETH_COLLATERAL_BY_CHAIN,
    ),
    arbitrum: getCollateralTokenConfigForChain(
      'arbitrum',
      routerConfig,
      ownersByChain,
      WETH_COLLATERAL_BY_CHAIN,
    ),
    base: getCollateralTokenConfigForChain(
      'base',
      routerConfig,
      ownersByChain,
      WETH_COLLATERAL_BY_CHAIN,
    ),
  };
}

export async function getAevoWETHStagingWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  return buildAevoWETHWarpConfig(routerConfig, AEVO_STAGING_OWNERS);
}

export async function getAevoWETHWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  return buildAevoWETHWarpConfig(routerConfig, AEVO_PROD_OWNERS);
}

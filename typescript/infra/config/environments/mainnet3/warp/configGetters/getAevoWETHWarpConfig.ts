import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { AEVO_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import {
  AEVO_PROD_OWNERS,
  AEVO_ROUTER_XERC20_LIMITS,
  AEVO_STAGING_OWNERS,
  AEVO_WETH_LIMITS,
  AevoChain,
  AevoOwners,
  applyAevoSecurity,
} from './aevo.js';
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
  const withSecurity = (
    chain: AevoChain,
    leg: HypTokenRouterConfig,
  ): HypTokenRouterConfig =>
    applyAevoSecurity(leg, chain, ownersByChain, AEVO_WETH_LIMITS);

  return {
    aevo: withSecurity('aevo', {
      type: TokenType.XERC20,
      token: tokens.aevo.WETH,
      mailbox: routerConfig.aevo.mailbox,
      owner: ownersByChain.aevo,
      gas: AEVO_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      xERC20: { warpRouteLimits: AEVO_ROUTER_XERC20_LIMITS },
    }),
    optimism: withSecurity(
      'optimism',
      getCollateralTokenConfigForChain(
        'optimism',
        routerConfig,
        ownersByChain,
        WETH_COLLATERAL_BY_CHAIN,
      ),
    ),
    arbitrum: withSecurity(
      'arbitrum',
      getCollateralTokenConfigForChain(
        'arbitrum',
        routerConfig,
        ownersByChain,
        WETH_COLLATERAL_BY_CHAIN,
      ),
    ),
    base: withSecurity(
      'base',
      getCollateralTokenConfigForChain(
        'base',
        routerConfig,
        ownersByChain,
        WETH_COLLATERAL_BY_CHAIN,
      ),
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

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  AEVO_ORIGIN_CHAINS,
  AEVO_PROD_OWNERS,
  AEVO_ROUTER_XERC20_LIMITS,
  AEVO_STAGING_OWNERS,
  AEVO_USDC_LIMITS,
  AevoChain,
  AevoOwners,
  applyAevoSecurity,
} from './aevo.js';
import {
  getRebalancingUSDCConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

// Aevo USDC: HypXERC20 over the existing Aevo token + collateral legs on the origin chains.
// Staging and prod share the structure (and the prod CCTP v2 bridges); only owners differ.
function buildAevoUSDCWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: AevoOwners,
): ChainMap<HypTokenRouterConfig> {
  // CCTP does not touch aevo, so the allowlist only covers the origin chains.
  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    AEVO_ORIGIN_CHAINS,
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const withSecurity = (
    chain: AevoChain,
    leg: HypTokenRouterConfig,
  ): HypTokenRouterConfig =>
    applyAevoSecurity(leg, chain, ownersByChain, AEVO_USDC_LIMITS);

  return {
    aevo: withSecurity('aevo', {
      type: TokenType.XERC20,
      token: tokens.aevo.USDC,
      mailbox: routerConfig.aevo.mailbox,
      owner: ownersByChain.aevo,
      xERC20: { warpRouteLimits: AEVO_ROUTER_XERC20_LIMITS },
    }),
    optimism: withSecurity(
      'optimism',
      getRebalancingUSDCConfigForChain(
        'optimism',
        routerConfig,
        ownersByChain,
        rebalancingConfigByChain,
      ),
    ),
    arbitrum: withSecurity(
      'arbitrum',
      getRebalancingUSDCConfigForChain(
        'arbitrum',
        routerConfig,
        ownersByChain,
        rebalancingConfigByChain,
      ),
    ),
    base: withSecurity(
      'base',
      getRebalancingUSDCConfigForChain(
        'base',
        routerConfig,
        ownersByChain,
        rebalancingConfigByChain,
      ),
    ),
  };
}

export async function getAevoUSDCStagingWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  return buildAevoUSDCWarpConfig(routerConfig, AEVO_STAGING_OWNERS);
}

export async function getAevoUSDCWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  return buildAevoUSDCWarpConfig(routerConfig, AEVO_PROD_OWNERS);
}

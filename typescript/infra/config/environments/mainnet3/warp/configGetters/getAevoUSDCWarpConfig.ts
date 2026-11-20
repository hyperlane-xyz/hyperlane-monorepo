import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { WarpRouteIds } from '../warpIds.js';
import { AEVO_PROD_OWNERS, AEVO_STAGING_OWNERS, AevoOwners } from './aevo.js';
import {
  getRebalancingUSDCConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

const AEVO_ORIGIN_CHAINS = ['optimism', 'arbitrum', 'base'] as const;

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

  return {
    aevo: {
      type: TokenType.XERC20,
      token: tokens.aevo.USDC,
      mailbox: routerConfig.aevo.mailbox,
      owner: ownersByChain.aevo,
    },
    optimism: getRebalancingUSDCConfigForChain(
      'optimism',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    arbitrum: getRebalancingUSDCConfigForChain(
      'arbitrum',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    base: getRebalancingUSDCConfigForChain(
      'base',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
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

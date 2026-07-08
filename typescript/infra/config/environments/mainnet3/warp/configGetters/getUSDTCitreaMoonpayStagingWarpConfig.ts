import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

// Staging mimic of the production CROSS/moonpay USDT route (getUSDTCitreaMoonpayWarpConfig).
// Same simplifications as the USDC staging getter: deployer-owned, default ISM, default hook,
// zero fee, no rebalancing. 6 EVM chains (no Solana XO leg, no Citrea ctUSD leg — those live
// on the USDC route, same as prod).

// Troy's personal deployer key for staging; to be transferred to the AW deployer later.
const DEPLOYER_EVM = '0x1cFd6A81e98de59e3eeB3AE35c3cb13FCb586E1E';

// Cross-collateral peers reference the sibling USDC staging route by deployed address.
// Returns {} until that route is registered; wire on a second pass via `warp apply`.
function getSiblingCrossCollateralRouters(): Record<string, string[]> {
  const route = getRegistry().getWarpRoute(
    WarpRouteIds.USDCCitreaMoonpaySTAGING,
  );
  if (!route) return {};
  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }) => {
      assert(addressOrDenom, `Missing USDC staging router for ${chainName}`);
      return [
        String(getDomainId(chainName)),
        [addressToBytes32(addressOrDenom)],
      ];
    }),
  );
}

export async function getUSDTCitreaMoonpayStagingWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const crossCollateralRouters = getSiblingCrossCollateralRouters();

  return {
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDT,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDT,
      mailbox: routerConfig.base.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    bsc: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDT,
      mailbox: routerConfig.bsc.mailbox,
      owner: DEPLOYER_EVM,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      crossCollateralRouters,
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDT,
      mailbox: routerConfig.ethereum.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    katana: {
      type: TokenType.crossCollateral,
      token: tokens.katana.USDT,
      mailbox: routerConfig.katana.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    polygon: {
      type: TokenType.crossCollateral,
      token: tokens.polygon.USDT,
      mailbox: routerConfig.polygon.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
  };
}

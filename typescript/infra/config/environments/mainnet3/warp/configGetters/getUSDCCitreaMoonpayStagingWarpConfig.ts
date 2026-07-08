import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';

// Staging mimic of the production CROSS/moonpay USDC route (getUSDCCitreaMoonpayWarpConfig).
// Deliberately simplified for a deployer-owned test route:
//   - all routers owned by the deployer key (easy iteration, no Safe/ICA governance)
//   - default ISM everywhere (omit interchainSecurityModule -> mailbox default ISM)
//   - default hook on EVM (omit hook); Solana keeps its IGP hook (required)
//   - zero warp fee (omit tokenFee) -> no offchain-quote / CCR fee surface
//   - no rebalancing config (no allowedRebalancers / allowedRebalancingBridges)
// NOTE: this intentionally does NOT reproduce prod's anti-arb OffchainQuotedLinearFee design.

// Troy's personal deployer keys for staging; to be transferred to the AW deployer later.
const DEPLOYER_EVM = '0x1cFd6A81e98de59e3eeB3AE35c3cb13FCb586E1E';
const DEPLOYER_SOLANA = 'D4jZ2sNktKgTrhWVMnjZb5BXP7MMh9N3y5ZLwkyKfozb';

const SOLANA_IGP_ADDRESS = 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv';
const SOLANA_XO_TOKEN_MINT = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y';
const SOLANA_XO_NAME = 'XO Cash';
const SOLANA_XO_SYMBOL = 'XO';

// Cross-collateral peers reference the sibling USDT staging route by deployed address.
// On the first deploy that route does not exist yet, so return {} and wire the peers on a
// second pass via `warp apply` once both routes are registered.
function getSiblingCrossCollateralRouters(): Record<string, string[]> {
  const route = getRegistry().getWarpRoute(
    WarpRouteIds.USDTCitreaMoonpaySTAGING,
  );
  if (!route) return {};
  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }) => {
      assert(addressOrDenom, `Missing USDT staging router for ${chainName}`);
      return [
        String(getDomainId(chainName)),
        [addressToBytes32(addressOrDenom)],
      ];
    }),
  );
}

export async function getUSDCCitreaMoonpayStagingWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const crossCollateralRouters = getSiblingCrossCollateralRouters();

  return {
    solanamainnet: {
      type: TokenType.crossCollateral,
      token: SOLANA_XO_TOKEN_MINT,
      mailbox: routerConfig.solanamainnet.mailbox,
      owner: DEPLOYER_SOLANA,
      hook: SOLANA_IGP_ADDRESS,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      name: SOLANA_XO_NAME,
      symbol: SOLANA_XO_SYMBOL,
      decimals: 6,
      crossCollateralRouters,
    },
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDC,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDC,
      mailbox: routerConfig.base.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    bsc: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDC,
      mailbox: routerConfig.bsc.mailbox,
      owner: DEPLOYER_EVM,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      crossCollateralRouters,
    },
    citrea: {
      type: TokenType.crossCollateral,
      token: tokens.citrea.ctUSD,
      mailbox: routerConfig.citrea.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDC,
      mailbox: routerConfig.ethereum.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    katana: {
      type: TokenType.crossCollateral,
      token: tokens.katana.USDC,
      mailbox: routerConfig.katana.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
    polygon: {
      type: TokenType.crossCollateral,
      token: tokens.polygon.USDC,
      mailbox: routerConfig.polygon.mailbox,
      owner: DEPLOYER_EVM,
      crossCollateralRouters,
    },
  };
}

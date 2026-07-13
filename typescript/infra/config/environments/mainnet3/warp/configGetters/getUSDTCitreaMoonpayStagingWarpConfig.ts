import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { DEPLOYER } from '../../owners.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  getRebalancingBridgesConfigFor,
  getWarpRouteAddressByChain,
} from './utils.js';

// Upgrade the base CCR to the #8894 impl (needed for isRebalanceTarget/
// addRebalanceTarget + local-domain addBridge). Matches the pending core major.
const REBALANCE_TARGET_CONTRACT_VERSION = '12.0.0';

// Staging mimic of the production CROSS/moonpay USDT route (getUSDTCitreaMoonpayWarpConfig).
// Same simplifications as the USDC staging getter: deployer-owned, default ISM, default hook,
// zero fee. 6 EVM chains (no Solana XO leg, no Citrea ctUSD leg — those live
// on the USDC route, same as prod).
// Rebalancing IS reproduced from prod: same allowedRebalancers (MCR signer) and the same
// OFT + Eclipse USDT bridge wiring (arbitrum/bsc/ethereum/polygon; base + katana have none).
// EXTRA_REBALANCER is additionally permitted on every leg for staging.

// Owned by the shared Hyperlane deployer key (owners.ts DEPLOYER).
const DEPLOYER_EVM = DEPLOYER;

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';
const EXTRA_REBALANCER = '0x2cB236403574301029c7bDDfda133c6e0338a857';
const ALLOWED_REBALANCERS = [REBALANCER, EXTRA_REBALANCER];

const EVM_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;

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

  const oftRebalancingConfigByChain = getRebalancingBridgesConfigFor(
    [...EVM_CHAINS, 'bsc'],
    [WarpRouteIds.USDTOft, WarpRouteIds.EclipseUSDT],
  );

  assert(oftRebalancingConfigByChain.bsc, 'missing rebalancing config for bsc');

  // Same-chain local rebalancing bridge (USDT-sourced) + its sibling USDC CCR
  // rebalance target on Base — both resolved from the registry by warpId.
  const localBridgeBase = getWarpRouteAddressByChain(
    WarpRouteIds.CROSSMoonpayStagingLocalBridgeUSDT,
    'base',
  );
  const usdcCcrBase = getWarpRouteAddressByChain(
    WarpRouteIds.USDCCitreaMoonpaySTAGING,
    'base',
  );

  return {
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDT,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: DEPLOYER_EVM,
      ...oftRebalancingConfigByChain.arbitrum,
      allowedRebalancers: ALLOWED_REBALANCERS,
      crossCollateralRouters,
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDT,
      mailbox: routerConfig.base.mailbox,
      owner: DEPLOYER_EVM,
      // Authorize the local rebalancing bridge as a rebalancer AND a bridge, and
      // register its sibling USDC CCR as a same-chain rebalance target.
      contractVersion: REBALANCE_TARGET_CONTRACT_VERSION,
      allowedRebalancers: [EXTRA_REBALANCER, localBridgeBase],
      allowedRebalancingBridges: {
        [String(getDomainId('base'))]: [{ bridge: localBridgeBase }],
      },
      rebalanceTargets: { [String(getDomainId('base'))]: [usdcCcrBase] },
      // Local-domain rebalance recipient: setRecipient(base, USDC-CCR) so the
      // ALRB escrow's source.rebalance(localDomain,…) can resolve _recipient
      // (rebalanceTargets only satisfies isRebalanceTarget, not _recipient).
      rebalanceRecipients: { [String(getDomainId('base'))]: usdcCcrBase },
      crossCollateralRouters,
    },
    bsc: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDT,
      mailbox: routerConfig.bsc.mailbox,
      owner: DEPLOYER_EVM,
      ...oftRebalancingConfigByChain.bsc,
      allowedRebalancers: ALLOWED_REBALANCERS,
      // bsc USDT is 18-decimal (vs 6 elsewhere); the 1e12 scale reconciles it.
      // Declaring name/symbol/decimals makes this leg satisfy TokenMetadataSchema
      // so `warp apply`'s metadata derivation preserves `scale` (otherwise the
      // scale is dropped and cross-chain decimals fail verification).
      name: 'Tether USD',
      symbol: 'USDT',
      decimals: 18,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      crossCollateralRouters,
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDT,
      mailbox: routerConfig.ethereum.mailbox,
      owner: DEPLOYER_EVM,
      ...oftRebalancingConfigByChain.ethereum,
      allowedRebalancers: ALLOWED_REBALANCERS,
      crossCollateralRouters,
    },
    katana: {
      type: TokenType.crossCollateral,
      token: tokens.katana.USDT,
      mailbox: routerConfig.katana.mailbox,
      owner: DEPLOYER_EVM,
      allowedRebalancers: [EXTRA_REBALANCER],
      crossCollateralRouters,
    },
    polygon: {
      type: TokenType.crossCollateral,
      token: tokens.polygon.USDT,
      mailbox: routerConfig.polygon.mailbox,
      owner: DEPLOYER_EVM,
      ...oftRebalancingConfigByChain.polygon,
      allowedRebalancers: ALLOWED_REBALANCERS,
      crossCollateralRouters,
    },
  };
}

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { DEPLOYER } from '../../owners.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  getRebalancingBridgesConfigFor,
  getUSDCRebalancingBridgesConfigFor,
  getWarpRouteAddressByChain,
  mergeAllowedBridges,
} from './utils.js';

// Contract version to upgrade the base CCR to (the #8894 impl, needed for
// isRebalanceTarget/addRebalanceTarget + local-domain addBridge). Matches the
// pending audit-branch major release for @hyperlane-xyz/core.
const REBALANCE_TARGET_CONTRACT_VERSION = '12.0.0';

// Staging mimic of the production CROSS/moonpay USDC route (getUSDCCitreaMoonpayWarpConfig).
// Deliberately simplified for a deployer-owned test route:
//   - all routers owned by the deployer key (easy iteration, no Safe/ICA governance)
//   - default ISM everywhere (omit interchainSecurityModule -> mailbox default ISM)
//   - default hook on EVM (omit hook); Solana keeps its IGP hook (required)
//   - zero warp fee (omit tokenFee) -> no offchain-quote / CCR fee surface
// Rebalancing IS reproduced from prod: same allowedRebalancers (MCR signer) and the same
// CCTP + Eclipse/Paradex/Igra/Radix + Iron (TBDA) bridge wiring per leg.
// EXTRA_REBALANCER is additionally permitted on every EVM leg for staging (the Solana leg
// has no rebalancer, matching prod).

// Owned by the Hyperlane deployer key: EVM uses the shared DEPLOYER (owners.ts);
// the Solana XO leg uses the mainnet3 sealevel deployer pubkey.
const DEPLOYER_EVM = DEPLOYER;
const DEPLOYER_SOLANA = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';

const SOLANA_IGP_ADDRESS = 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv';
const SOLANA_XO_TOKEN_MINT = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y';
const SOLANA_XO_NAME = 'XO Cash';
const SOLANA_XO_SYMBOL = 'XO';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';
const EXTRA_REBALANCER = '0x2cB236403574301029c7bDDfda133c6e0338a857';
const ALLOWED_REBALANCERS = [REBALANCER, EXTRA_REBALANCER];
const EVM_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;
type EvmChain = (typeof EVM_CHAINS)[number];

function getTBDAAddresses(): Record<
  'arbitrum' | 'base' | 'ethereum' | 'citrea' | 'polygon',
  string
> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDCCitreaIronBridge);
  assert(route, 'CROSS/ctusd-usdc-ironbridge route not found in registry');

  const find = (chain: EvmChain | 'citrea') => {
    const token = route.tokens.find((t) => t.chainName === chain);
    assert(token?.addressOrDenom, `Missing TBDA address for ${chain}`);
    return token.addressOrDenom;
  };

  return {
    arbitrum: find('arbitrum'),
    base: find('base'),
    ethereum: find('ethereum'),
    citrea: find('citrea'),
    polygon: find('polygon'),
  };
}

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

  const cctpRebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    ['arbitrum', 'base', 'ethereum', 'polygon'],
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const additionalRebalancingConfigByChain = getRebalancingBridgesConfigFor(
    ['arbitrum', 'base', 'bsc', 'ethereum', 'polygon'],
    [
      WarpRouteIds.EclipseUSDC,
      WarpRouteIds.ParadexUSDC,
      WarpRouteIds.IgraUSDC,
      WarpRouteIds.RadixUSDC,
    ],
  );

  const tbda = getTBDAAddresses();

  assert(
    additionalRebalancingConfigByChain.bsc,
    'missing rebalancing config for bsc',
  );

  // Same-chain local rebalancing bridge (USDC-sourced) + its sibling USDT CCR
  // rebalance target on Base — both resolved from the registry by warpId.
  const localBridgeBase = getWarpRouteAddressByChain(
    WarpRouteIds.CROSSMoonpayStagingLocalBridgeUSDC,
    'base',
  );
  const usdtCcrBase = getWarpRouteAddressByChain(
    WarpRouteIds.USDTCitreaMoonpaySTAGING,
    'base',
  );

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
      ...cctpRebalancingConfigByChain.arbitrum,
      allowedRebalancers: ALLOWED_REBALANCERS,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.arbitrum.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.arbitrum?.allowedRebalancingBridges,
        { [String(getDomainId('citrea'))]: [{ bridge: tbda.arbitrum }] },
      ),
      crossCollateralRouters,
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDC,
      mailbox: routerConfig.base.mailbox,
      owner: DEPLOYER_EVM,
      ...cctpRebalancingConfigByChain.base,
      // Authorize the local rebalancing bridge as a rebalancer AND a bridge, and
      // register its sibling USDT CCR as a same-chain rebalance target. Upgrade
      // the CCR to the #8894 impl so these are supported on-chain.
      contractVersion: REBALANCE_TARGET_CONTRACT_VERSION,
      allowedRebalancers: [...ALLOWED_REBALANCERS, localBridgeBase],
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.base.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.base?.allowedRebalancingBridges,
        { [String(getDomainId('citrea'))]: [{ bridge: tbda.base }] },
        { [String(getDomainId('base'))]: [{ bridge: localBridgeBase }] },
      ),
      rebalanceTargets: { [String(getDomainId('base'))]: [usdtCcrBase] },
      crossCollateralRouters,
    },
    bsc: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDC,
      mailbox: routerConfig.bsc.mailbox,
      owner: DEPLOYER_EVM,
      ...additionalRebalancingConfigByChain.bsc,
      allowedRebalancers: ALLOWED_REBALANCERS,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      crossCollateralRouters,
    },
    citrea: {
      type: TokenType.crossCollateral,
      token: tokens.citrea.ctUSD,
      mailbox: routerConfig.citrea.mailbox,
      owner: DEPLOYER_EVM,
      allowedRebalancers: ALLOWED_REBALANCERS,
      allowedRebalancingBridges: Object.fromEntries(
        EVM_CHAINS.map((dest) => [
          String(getDomainId(dest)),
          [{ bridge: tbda.citrea }],
        ]),
      ),
      crossCollateralRouters,
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDC,
      mailbox: routerConfig.ethereum.mailbox,
      owner: DEPLOYER_EVM,
      ...cctpRebalancingConfigByChain.ethereum,
      allowedRebalancers: ALLOWED_REBALANCERS,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.ethereum.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.ethereum?.allowedRebalancingBridges,
        { [String(getDomainId('citrea'))]: [{ bridge: tbda.ethereum }] },
      ),
      crossCollateralRouters,
    },
    katana: {
      type: TokenType.crossCollateral,
      token: tokens.katana.USDC,
      mailbox: routerConfig.katana.mailbox,
      owner: DEPLOYER_EVM,
      allowedRebalancers: [EXTRA_REBALANCER],
      crossCollateralRouters,
    },
    polygon: {
      type: TokenType.crossCollateral,
      token: tokens.polygon.USDC,
      mailbox: routerConfig.polygon.mailbox,
      owner: DEPLOYER_EVM,
      ...cctpRebalancingConfigByChain.polygon,
      allowedRebalancers: ALLOWED_REBALANCERS,
      allowedRebalancingBridges: mergeAllowedBridges(
        cctpRebalancingConfigByChain.polygon.allowedRebalancingBridges,
        additionalRebalancingConfigByChain.polygon?.allowedRebalancingBridges,
        { [String(getDomainId('citrea'))]: [{ bridge: tbda.polygon }] },
      ),
      crossCollateralRouters,
    },
  };
}

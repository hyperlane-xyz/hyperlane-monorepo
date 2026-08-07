import {
  ChainMap,
  DEFAULT_ROUTER_KEY,
  HypTokenRouterConfig,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { DEPLOYER } from '../../owners.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  getCrossCollateralTargetRoutersByChain,
  getRebalancingBridgesConfigFor,
} from './utils.js';

// Staging mimic of the production CROSS/moonpay USDT route (getUSDTCitreaMoonpayWarpConfig).
// Same simplifications as the USDC staging getter: deployer-owned, default ISM and default hook.
// Only BSC enables the staging fee experiment. 6 EVM chains (no Solana XO leg, no Citrea ctUSD leg — those live
// on the USDC route, same as prod).
// Rebalancing IS reproduced from prod: same allowedRebalancers (MCR signer) and the same
// OFT + Eclipse USDT bridge wiring (arbitrum/bsc/ethereum/polygon; base + katana have none).
// EXTRA_REBALANCER is additionally permitted on every leg for staging.

// Owned by the shared Hyperlane deployer key (owners.ts DEPLOYER).
const DEPLOYER_EVM = DEPLOYER;

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';
const EXTRA_REBALANCER = '0x2cB236403574301029c7bDDfda133c6e0338a857';
const ALLOWED_REBALANCERS = [REBALANCER, EXTRA_REBALANCER];
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

const STAGING_ROUTE_IDS = [
  WarpRouteIds.USDCCitreaMoonpaySTAGING,
  WarpRouteIds.USDTCitreaMoonpaySTAGING,
] as const;

const INITIAL_FALLBACK = {
  // BSC USDT is locally 18 decimals, and fees are quoted against the source
  // amount before the router applies its 1e12 scale-down for the 6-decimal wire amount.
  breakpoints: [
    100_000_000_000_000_000_000_000n,
    250_000_000_000_000_000_000_000n,
  ],
  marginalBps: [4, 10, 20],
};

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

export function buildBscUsdtTokenFeeForTargets(
  destinations: readonly string[],
  arbitrumUsdcRouter: string,
): TokenFeeConfigInput {
  const arbitrumUsdcRouterKey = addressToBytes32(arbitrumUsdcRouter);
  const linearFee = (): TokenFeeConfigInput => ({
    type: TokenFeeType.OffchainQuotedLinearFee,
    owner: DEPLOYER_EVM,
    bps: 3,
    quoteSigners: QUOTE_SIGNERS,
  });
  const piecewiseFee = (): TokenFeeConfigInput => ({
    type: TokenFeeType.OffchainQuotedPiecewiseLinearFee,
    owner: DEPLOYER_EVM,
    maxBands: 4,
    quoteSigners: QUOTE_SIGNERS,
    initialFallback: INITIAL_FALLBACK,
  });

  return {
    type: TokenFeeType.CrossCollateralRoutingFee,
    owner: DEPLOYER_EVM,
    feeContracts: Object.fromEntries(
      destinations.map((destination) => [
        destination,
        {
          [DEFAULT_ROUTER_KEY]: linearFee(),
          ...(destination === 'arbitrum'
            ? { [arbitrumUsdcRouterKey]: piecewiseFee() }
            : {}),
        },
      ]),
    ),
  };
}

function buildBscUsdtTokenFee(): TokenFeeConfigInput {
  const targetsByChain =
    getCrossCollateralTargetRoutersByChain(STAGING_ROUTE_IDS);
  const usdcRoute = getRegistry().getWarpRoute(
    WarpRouteIds.USDCCitreaMoonpaySTAGING,
  );
  assert(usdcRoute, 'USDC/moonpay-staging route not found in registry');
  const arbitrumUsdc = usdcRoute.tokens.find(
    ({ chainName }) => chainName === 'arbitrum',
  );
  assert(
    arbitrumUsdc?.addressOrDenom,
    'Missing Arbitrum USDC/moonpay-staging router',
  );
  return buildBscUsdtTokenFeeForTargets(
    Object.keys(targetsByChain),
    arbitrumUsdc.addressOrDenom,
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
      allowedRebalancers: [EXTRA_REBALANCER],
      crossCollateralRouters,
    },
    bsc: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDT,
      mailbox: routerConfig.bsc.mailbox,
      owner: DEPLOYER_EVM,
      ...oftRebalancingConfigByChain.bsc,
      allowedRebalancers: ALLOWED_REBALANCERS,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      crossCollateralRouters,
      tokenFee: buildBscUsdtTokenFee(),
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

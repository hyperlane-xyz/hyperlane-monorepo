import {
  ChainMap,
  ChainName,
  DEFAULT_ROUTER_KEY,
  TokenFeeConfigInput,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { getDomainId, getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';
import { getCrossCollateralTargetRoutersByChain } from './utils.js';

export const MOONPAY_ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'arc',
  'base',
  'bsc',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
  'robinhood',
] as const satisfies readonly ChainName[];

export function getMoonpayUsdgRouter(): string | undefined {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDGRobinhoodMoonpay);
  // First deploy has no USDG address yet. Register it before applying the connections.
  if (!route) return undefined;
  assert(route.tokens.length === 1, 'USDG/moonpay must have exactly one leg');
  const token = route.tokens[0];
  assert(
    token.chainName === 'robinhood' && token.addressOrDenom,
    'Missing USDG Robinhood router',
  );
  return addressToBytes32(token.addressOrDenom);
}

export function getMoonpayCrossCollateralRouters(
  routeIds: readonly WarpRouteIds[],
  includeUsdg = true,
): Record<string, string[]> {
  const targets = getCrossCollateralTargetRoutersByChain(routeIds);
  const usdgRouter = includeUsdg ? getMoonpayUsdgRouter() : undefined;
  if (usdgRouter) targets.robinhood = [usdgRouter];
  return Object.fromEntries(
    Object.entries(targets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([chain, routers]) => [
        String(getDomainId(chain)),
        [...routers].sort(),
      ]),
  );
}

export function getMoonpayTargetRouters(): ChainMap<string[]> {
  const targets = getCrossCollateralTargetRoutersByChain([
    WarpRouteIds.USDCCitreaMoonpay,
    WarpRouteIds.USDTCitreaMoonpay,
  ]);
  const router = getMoonpayUsdgRouter();
  if (router) targets.robinhood = [router];
  return targets;
}

export const MOONPAY_DEFAULT_FEE_BPS = 3;

export function buildCrossCollateralRoutingFee(
  owner: string,
  destinations: readonly ChainName[],
): TokenFeeConfigInput {
  const targets = getMoonpayTargetRouters();
  // TODO: set arc router-specific fees in the next MoonPay route update and
  // remove this exception. They were not set on-chain because the arc legs
  // were deployed after the fee contracts; the default fee router covers arc.
  delete targets.arc;
  const offchainFee = (): TokenFeeConfigInput => ({
    type: TokenFeeType.OffchainQuotedLinearFee,
    owner,
    bps: MOONPAY_DEFAULT_FEE_BPS,
    quoteSigners: [
      '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
      '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
    ],
  });
  return {
    type: TokenFeeType.CrossCollateralRoutingFee,
    owner,
    feeContracts: Object.fromEntries(
      destinations.map((dest) => [
        dest,
        {
          ...Object.fromEntries(
            (targets[dest] ?? []).map((router) => [router, offchainFee()]),
          ),
          [DEFAULT_ROUTER_KEY]: offchainFee(),
        },
      ]),
    ),
  };
}

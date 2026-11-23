import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { getDomainId, getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';
import { REBALANCER } from './utils.js';

export const USDG_STAGING_USDC_CHAINS = [
  'arbitrum',
  'arc',
  'base',
  'ethereum',
] as const;

export function getMoonpayStagingRebalancers(): string[] {
  const staging = process.env.STAGING_REBALANCER_ADDRESS;
  assert(
    staging && /^0x[\da-fA-F]{40}$/.test(staging),
    'Set STAGING_REBALANCER_ADDRESS to the dedicated staging wallet',
  );
  assert(
    staging.toLowerCase() !== REBALANCER.toLowerCase() &&
      staging.toLowerCase() !== '0x93240ad82ca750da33de564f8dce8ebeb5885822',
    'Staging must not use a production Moonpay wallet',
  );
  // Retain existing staging permissions; add the isolated canary signer.
  return [
    ...new Set([
      REBALANCER,
      '0x2cB236403574301029c7bDDfda133c6e0338a857',
      staging,
    ]),
  ];
}

/** Two-pass deployment: the newly deployed sibling must be registered before apply. */
export function getMoonpayStagingUsdGPeers(): Record<string, string[]> {
  const route = getRegistry().getWarpRoute(
    WarpRouteIds.USDGRobinhoodMoonpaySTAGING,
  );
  if (!route) return {};
  assert(
    route.tokens.length === 1 && route.tokens[0].chainName === 'robinhood',
    'Expected one Robinhood USDG staging leg',
  );
  const address = route.tokens[0].addressOrDenom;
  assert(address, 'Missing USDG staging router');
  return { [getDomainId('robinhood')]: [addressToBytes32(address)] };
}

export function getMoonpayStagingUsdcPeers(): Record<string, string[]> {
  const route = getRegistry().getWarpRoute(
    WarpRouteIds.USDCCitreaMoonpaySTAGING,
  );
  assert(
    route,
    'Register the USDC staging route before deploying USDG staging',
  );
  return Object.fromEntries(
    USDG_STAGING_USDC_CHAINS.map((chain) => {
      const token = route.tokens.find((token) => token.chainName === chain);
      assert(token?.addressOrDenom, `Missing ${chain} USDC staging router`);
      return [
        String(getDomainId(chain)),
        [addressToBytes32(token.addressOrDenom)],
      ];
    }),
  );
}

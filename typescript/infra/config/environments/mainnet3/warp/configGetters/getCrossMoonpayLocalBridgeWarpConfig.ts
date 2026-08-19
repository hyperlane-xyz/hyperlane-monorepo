import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { WarpRouteIds } from '../warpIds.js';

const DEPLOYMENT_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'polygon',
] as const;

const OWNERS_BY_CHAIN = {
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  bsc: awIcas.bsc,
  ethereum: awSafes.ethereum,
  polygon: awIcas.polygon,
} as const;

const DECIMALS_BY_CHAIN = {
  arbitrum: 6,
  base: 6,
  bsc: 18,
  ethereum: 6,
  polygon: 6,
} as const;

function getSourceRouters(): ChainMap<string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDTCitreaMoonpay);
  assert(route, 'USDT/moonpay route not found in registry');

  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }): [string, string] => {
      assert(addressOrDenom, `Missing Moonpay USDT router for ${chainName}`);
      return [chainName, addressOrDenom];
    }),
  );
}

export async function getCrossMoonpayLocalBridgeWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const sourceRouters = getSourceRouters();

  return Object.fromEntries(
    DEPLOYMENT_CHAINS.map((chain) => {
      const sourceRouter = sourceRouters[chain];
      assert(sourceRouter, `Missing Moonpay USDT router for ${chain}`);

      return [
        chain,
        {
          ...routerConfig[chain],
          owner: OWNERS_BY_CHAIN[chain],
          type: TokenType.atomicLocalRebalancing,
          sourceRouter,
          decimals: DECIMALS_BY_CHAIN[chain],
          ...(chain === 'bsc'
            ? { scale: { numerator: 1, denominator: 1_000_000_000_000 } }
            : {}),
          name: 'Moonpay Local Rebalancing Bridge',
          symbol: 'mpALRB',
        },
      ];
    }),
  );
}

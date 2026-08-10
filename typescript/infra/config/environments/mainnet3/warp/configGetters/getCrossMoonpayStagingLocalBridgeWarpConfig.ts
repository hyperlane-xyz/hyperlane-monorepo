import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { DEPLOYER } from '../../owners.js';
import { WarpRouteIds } from '../warpIds.js';

const DEPLOYMENT_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'polygon',
] as const;

const TOKEN_METADATA = {
  name: 'Moonpay Staging Local Rebalancing Bridge',
  symbol: 'mpALRB-STAGE',
} as const;

function getSourceRouters(): ChainMap<string> {
  const route = getRegistry().getWarpRoute(
    WarpRouteIds.USDTCitreaMoonpaySTAGING,
  );
  assert(route, 'USDT/moonpay-staging route not found in registry');

  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }): [string, string] => {
      assert(addressOrDenom, `Missing USDT staging router for ${chainName}`);
      return [chainName, addressOrDenom];
    }),
  );
}

export async function getCrossMoonpayStagingLocalBridgeWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const sourceRouters = getSourceRouters();

  return Object.fromEntries(
    DEPLOYMENT_CHAINS.map((chain) => {
      const sourceRouter = sourceRouters[chain];
      assert(sourceRouter, `Missing USDT staging router for ${chain}`);

      return [
        chain,
        {
          ...TOKEN_METADATA,
          decimals: chain === 'bsc' ? 18 : 6,
          mailbox: routerConfig[chain].mailbox,
          owner: DEPLOYER,
          type: TokenType.atomicLocalRebalancing,
          sourceRouter,
          ...(chain === 'bsc'
            ? { scale: { numerator: 1, denominator: 1_000_000_000_000 } }
            : {}),
        },
      ];
    }),
  );
}

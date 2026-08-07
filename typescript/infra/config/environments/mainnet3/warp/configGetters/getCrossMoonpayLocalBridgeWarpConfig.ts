import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { WarpRouteIds } from '../warpIds.js';

const deploymentChains = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'polygon',
] as const;

const ownersByChain = {
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  bsc: awIcas.bsc,
  ethereum: awSafes.ethereum,
  polygon: awIcas.polygon,
} as const;

const decimalsByChain = {
  arbitrum: 6,
  base: 6,
  bsc: 18,
  ethereum: 6,
  polygon: 6,
} as const;

// Each bridge binds the local USDT router as its immutable source. The route
// contains one independently deployed bridge per supported chain.
const SOURCE_WARP_ROUTE_ID_BY_DIRECTION: Record<string, WarpRouteIds> = {
  [WarpRouteIds.CROSSMoonpayLocalBridgeUSDT]: WarpRouteIds.USDTCitreaMoonpay,
};

function getSourceRoutersByChain(sourceWarpRouteId: string): ChainMap<string> {
  const route = getRegistry().getWarpRoute(sourceWarpRouteId);
  assert(route, `Source warp route ${sourceWarpRouteId} not found in registry`);

  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }): [string, string] => {
      assert(
        addressOrDenom,
        `Expected source router address for ${sourceWarpRouteId} on ${chainName}`,
      );
      return [chainName, addressOrDenom];
    }),
  );
}

export const getCrossMoonpayLocalBridgeWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: unknown,
  warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const sourceWarpRouteId = SOURCE_WARP_ROUTE_ID_BY_DIRECTION[warpRouteId];
  assert(
    sourceWarpRouteId,
    `No local rebalancing bridge direction registered for ${warpRouteId}`,
  );
  const sourceRoutersByChain = getSourceRoutersByChain(sourceWarpRouteId);

  return Object.fromEntries(
    deploymentChains.map((chain) => {
      const sourceRouter = sourceRoutersByChain[chain];
      assert(
        sourceRouter,
        `No ${sourceWarpRouteId} source router deployed on ${chain}`,
      );

      return [
        chain,
        {
          ...routerConfig[chain],
          owner: ownersByChain[chain],
          type: TokenType.atomicLocalRebalancing,
          sourceRouter,
          decimals: decimalsByChain[chain],
          ...(chain === 'bsc'
            ? { scale: { numerator: 1, denominator: 1_000_000_000_000 } }
            : {}),
          name: 'Moonpay Local Rebalancing Bridge',
          symbol: 'mpALRB',
        },
      ];
    }),
  );
};

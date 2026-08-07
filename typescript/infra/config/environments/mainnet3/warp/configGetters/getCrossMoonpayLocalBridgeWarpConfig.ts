import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { awIcas } from '../../governance/ica/aw.js';
import { WarpRouteIds } from '../warpIds.js';

const deploymentChains = ['base'] as const;

// Each bridge has one immutable source router, so USDC -> USDT and USDT -> USDC
// are deployed as separate one-chain routes.
const SOURCE_WARP_ROUTE_ID_BY_DIRECTION: Record<string, WarpRouteIds> = {
  [WarpRouteIds.CROSSMoonpayLocalBridgeUSDC]: WarpRouteIds.USDCCitreaMoonpay,
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
          owner: awIcas[chain],
          type: TokenType.atomicLocalRebalancing,
          sourceRouter,
          decimals: 6,
          name: 'Moonpay Local Rebalancing Bridge',
          symbol: 'mpALRB',
        },
      ];
    }),
  );
};

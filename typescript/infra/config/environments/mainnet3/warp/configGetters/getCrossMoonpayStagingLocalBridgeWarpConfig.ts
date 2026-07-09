import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { DEPLOYER } from '../../owners.js';
import { WarpRouteIds } from '../warpIds.js';

// Owner of the deployed bridges. Matches the current CROSS/moonpay-staging router
// owner (the AW deployer, after the ownership transfer in registry #1590) so the
// same key can wire each bridge onto its source router (addRebalancer / addBridge
// / addRebalanceTarget).
const OWNER = DEPLOYER;

// Narrowed to Base for the initial deployment. Expand this list (per direction)
// once the mechanism is proven and the target CCRs are on the #8894 impl.
const deploymentChains = ['base'] as const;

// Each AtomicLocalRebalancingBridge binds ONE immutable source router, so the two
// same-chain rebalance directions are two separate warp routes. The source router
// per chain is read from the deployed CROSS/moonpay-staging leg for that direction;
// the sibling leg is the runtime `destinationRecipient` (not a deploy input).
const SOURCE_WARP_ROUTE_ID_BY_DIRECTION: Record<string, string> = {
  [WarpRouteIds.CROSSMoonpayStagingLocalBridgeUSDC]: 'USDC/moonpay-staging',
  [WarpRouteIds.CROSSMoonpayStagingLocalBridgeUSDT]: 'USDT/moonpay-staging',
};

// Reads chain -> router address for a deployed warp route from the registry,
// mirroring the sibling-router lookups in the prod moonpay getters.
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

// AtomicLocalRebalancingBridge is a bare ITokenBridge adapter that resolves the
// source/destination tokens dynamically at call time, so the token metadata below
// is cosmetic (only used to satisfy the warp-deploy metadata pipeline).
export const getCrossMoonpayStagingLocalBridgeWarpConfig = async (
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
          owner: OWNER,
          type: TokenType.atomicLocalRebalancing,
          sourceRouter,
          decimals: 6,
          name: 'Moonpay Staging Local Rebalancing Bridge',
          symbol: 'mpsALRB',
        },
      ];
    }),
  );
};

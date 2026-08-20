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

function getSourceTokens() {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDTCitreaMoonpay);
  assert(route, 'USDT/moonpay route not found in registry');

  return new Map(
    route.tokens.map((token) => [token.chainName, token] as const),
  );
}

export async function getCrossMoonpayLocalBridgeWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const sourceTokens = getSourceTokens();

  return Object.fromEntries(
    DEPLOYMENT_CHAINS.map((chain) => {
      const sourceToken = sourceTokens.get(chain);
      assert(sourceToken, `Missing Moonpay USDT token for ${chain}`);
      assert(
        sourceToken.addressOrDenom,
        `Missing Moonpay USDT router for ${chain}`,
      );

      return [
        chain,
        {
          ...routerConfig[chain],
          owner: OWNERS_BY_CHAIN[chain],
          type: TokenType.atomicLocalRebalancing,
          sourceRouter: sourceToken.addressOrDenom,
          decimals: sourceToken.decimals,
          ...(sourceToken.scale ? { scale: sourceToken.scale } : {}),
          name: 'Moonpay Local Rebalancing Bridge',
          symbol: 'mpALRB',
        },
      ];
    }),
  );
}

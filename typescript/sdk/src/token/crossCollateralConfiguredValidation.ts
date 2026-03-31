import {
  Address,
  assert,
  bytes32ToAddress,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { WarpCoreConfig } from '../warp/types.js';

import { TokenStandard } from './TokenStandard.js';
import {
  CrossCollateralRouterReference,
  CrossCollateralValidationNode,
  dedupeCrossCollateralRouterRefs,
  getCrossCollateralRouterId,
  validateCrossCollateralGraph,
} from './crossCollateralValidation.js';
import {
  WarpRouteDeployConfig,
  isCrossCollateralTokenConfig,
} from './types.js';

export type ConfiguredCrossCollateralRoute = {
  id: string;
  coreConfig: WarpCoreConfig;
  deployConfig: WarpRouteDeployConfig;
};

export async function validateConfiguredCrossCollateralGraph({
  multiProvider,
  routes,
}: {
  multiProvider: MultiProvider;
  routes: ConfiguredCrossCollateralRoute[];
}): Promise<void> {
  const nodes = new Map<string, CrossCollateralValidationNode>();
  const descriptions = new Map<string, string>();

  for (const route of routes) {
    assertConfiguredCrossCollateralRoute(route);

    const routeRefs = route.coreConfig.tokens.map((token) => ({
      chainName: token.chainName,
      routerAddress: token.addressOrDenom!,
    }));

    for (const token of route.coreConfig.tokens) {
      assert(
        token.addressOrDenom,
        `Route "${route.id}" token on chain "${token.chainName}" is missing addressOrDenom`,
      );

      const chainConfig = route.deployConfig[token.chainName];
      assert(
        isCrossCollateralTokenConfig(chainConfig),
        `Route "${route.id}" is missing CrossCollateralRouter deploy config on chain "${token.chainName}"`,
      );

      const ref = {
        chainName: token.chainName,
        routerAddress: token.addressOrDenom,
      };
      const routerId = getCrossCollateralRouterId(ref);
      descriptions.set(
        routerId,
        `route "${route.id}" on chain "${token.chainName}"`,
      );
      nodes.set(routerId, {
        ...ref,
        decimals: token.decimals,
        peers: dedupeCrossCollateralRouterRefs(
          routeRefs
            .filter(
              (peer) =>
                getCrossCollateralRouterId(peer) !==
                getCrossCollateralRouterId(ref),
            )
            .concat(
              getConfiguredCrossCollateralPeers(chainConfig, multiProvider),
            ),
        ),
        scale: token.scale,
        symbol: token.symbol,
      });
    }
  }

  await validateCrossCollateralGraph({
    roots: [...nodes.values()].map(({ chainName, routerAddress }) => ({
      chainName,
      routerAddress,
    })),
    describeRef: (ref) =>
      descriptions.get(getCrossCollateralRouterId(ref)) ??
      `"${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}"`,
    loadNode: async (ref) => {
      const node = nodes.get(getCrossCollateralRouterId(ref));
      assert(
        node,
        `Missing configured CrossCollateralRouter for ${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}`,
      );
      return node;
    },
  });
}

function assertConfiguredCrossCollateralRoute(
  route: ConfiguredCrossCollateralRoute,
): void {
  const invalidDeployChains = Object.entries(route.deployConfig)
    .filter(([, chainConfig]) => !isCrossCollateralTokenConfig(chainConfig))
    .map(([chain]) => chain);
  assert(
    invalidDeployChains.length === 0,
    `Route "${route.id}" contains non-CrossCollateralRouter deploy configs for chain(s): ${invalidDeployChains.join(', ')}`,
  );

  const invalidCoreTokens = route.coreConfig.tokens.filter(
    (token) => token.standard !== TokenStandard.EvmHypCrossCollateralRouter,
  );
  assert(
    invalidCoreTokens.length === 0,
    `Route "${route.id}" contains non-CrossCollateralRouter warp config token(s): ${invalidCoreTokens
      .map((token) => `${token.chainName}:${token.addressOrDenom}`)
      .join(', ')}`,
  );
}

function getConfiguredCrossCollateralPeers(
  chainConfig: WarpRouteDeployConfig[string],
  multiProvider: MultiProvider,
): CrossCollateralRouterReference[] {
  assert(
    isCrossCollateralTokenConfig(chainConfig),
    'Expected CrossCollateralRouter config',
  );
  return Object.entries(chainConfig.crossCollateralRouters ?? {}).flatMap(
    ([domain, routers]) => {
      const peerChainName = multiProvider.getChainName(Number(domain));
      return routers.map((router) => ({
        chainName: peerChainName,
        routerAddress: bytes32ToAddress(router) as Address,
      }));
    },
  );
}

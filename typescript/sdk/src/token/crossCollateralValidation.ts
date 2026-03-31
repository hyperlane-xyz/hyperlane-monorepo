import {
  CrossCollateralRouter__factory,
  ERC20__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  assert,
  isEVMLike,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { resolveRouterMapConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';
import {
  NormalizedScale,
  ScaleInput,
  normalizeScale,
} from '../utils/decimals.js';
import { WarpCoreConfig } from '../warp/types.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenType } from './config.js';
import {
  WarpRouteDeployConfig,
  isCrossCollateralTokenConfig,
} from './types.js';

export type CrossCollateralRouterReference = {
  chainName: ChainName;
  routerAddress: Address;
};

export type CrossCollateralValidationNode = CrossCollateralRouterReference & {
  decimals: number;
  scale?: ScaleInput;
  symbol: string;
};

export type CrossCollateralValidationNodeLoader = (
  ref: CrossCollateralRouterReference,
) => Promise<CrossCollateralValidationNode>;

type ExpectedCrossCollateralConfig = {
  type?: string;
  crossCollateralRouters?: Record<string, string[]>;
};

export type ConfiguredCrossCollateralRoute = {
  id: string;
  coreConfig: WarpCoreConfig;
  deployConfig: WarpRouteDeployConfig;
};

export function getCrossCollateralRouterId(
  ref: CrossCollateralRouterReference,
): string {
  return `${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}`;
}

export function dedupeCrossCollateralRouterRefs(
  refs: CrossCollateralRouterReference[],
): CrossCollateralRouterReference[] {
  const deduped = new Map<string, CrossCollateralRouterReference>();
  for (const ref of refs) {
    deduped.set(getCrossCollateralRouterId(ref), {
      chainName: ref.chainName,
      routerAddress: normalizeAddressEvm(ref.routerAddress),
    });
  }
  return [...deduped.values()];
}

export function formatCrossCollateralScaleForLogs(
  scale: ScaleInput | undefined,
): string {
  const normalizedScale = normalizeScale(scale);
  if (normalizedScale.denominator === 1n) {
    return normalizedScale.numerator.toString();
  }
  return `${normalizedScale.numerator}/${normalizedScale.denominator}`;
}

export function getMessageAmountTokenScale({
  decimals,
  scale,
}: {
  decimals: number;
  scale?: ScaleInput;
}): NormalizedScale {
  const normalizedScale = normalizeScale(scale);
  return {
    numerator: 10n ** BigInt(decimals) * normalizedScale.numerator,
    denominator: normalizedScale.denominator,
  };
}

export async function validateCrossCollateralGraph({
  describeRef,
  loadNode,
  roots,
  routers,
}: {
  describeRef?: (ref: CrossCollateralRouterReference) => string;
  loadNode: CrossCollateralValidationNodeLoader;
  roots?: CrossCollateralRouterReference[];
  routers?: CrossCollateralRouterReference[];
}): Promise<void> {
  const refs = dedupeCrossCollateralRouterRefs(routers ?? roots ?? []);
  if (refs.length <= 1) {
    return;
  }

  const getNode = getCachedCrossCollateralNodeLoader(loadNode);
  const nodes = await Promise.all(refs.map(getNode));
  assertConsistentCrossCollateralRouters(
    nodes,
    describeRef ?? describeCrossCollateralRouterRef,
  );
}

export function buildExpectedCrossCollateralRouters({
  configMap,
  multiProvider,
  routerAddresses,
}: {
  configMap: Record<string, ExpectedCrossCollateralConfig>;
  multiProvider: MultiProvider;
  routerAddresses: ChainMap<Address>;
}): CrossCollateralRouterReference[] {
  return dedupeCrossCollateralRouterRefs(
    Object.entries(configMap).flatMap(([chainName, config]) => {
      if (config.type !== TokenType.crossCollateral) {
        return [];
      }

      const routerAddress = routerAddresses[chainName];
      assert(
        routerAddress,
        `Missing CrossCollateralRouter address for chain "${chainName}"`,
      );

      return [
        { chainName, routerAddress },
        ...Object.entries(
          resolveRouterMapConfig(
            multiProvider,
            config.crossCollateralRouters ?? {},
          ),
        ).flatMap(([domainId, routers]) => {
          const peerChainName = multiProvider.getChainName(Number(domainId));
          return routers.map((peerAddress) => ({
            chainName: peerChainName,
            routerAddress: peerAddress,
          }));
        }),
      ];
    }),
  );
}

export async function validateOnchainCrossCollateralGraph({
  describeRef,
  multiProvider,
  roots,
  routers,
}: {
  describeRef?: (ref: CrossCollateralRouterReference) => string;
  multiProvider: MultiProvider;
  roots?: CrossCollateralRouterReference[];
  routers?: CrossCollateralRouterReference[];
}): Promise<void> {
  const readers = new Map<ChainName, EvmWarpRouteReader>();

  await validateCrossCollateralGraph({
    describeRef,
    loadNode: async (ref) => {
      assert(
        isEVMLike(multiProvider.getProtocol(ref.chainName)),
        `CrossCollateralRouter validation requires an EVM chain, got "${ref.chainName}"`,
      );

      const provider = multiProvider.getProvider(ref.chainName);
      const reader =
        readers.get(ref.chainName) ??
        new EvmWarpRouteReader(multiProvider, ref.chainName);
      readers.set(ref.chainName, reader);

      const crossCollateralRouter = CrossCollateralRouter__factory.connect(
        ref.routerAddress,
        provider,
      );
      const wrappedToken = ERC20__factory.connect(
        await crossCollateralRouter.wrappedToken(),
        provider,
      );
      const [decimals, scale, symbol] = await Promise.all([
        wrappedToken.decimals(),
        reader.fetchScale(ref.routerAddress),
        wrappedToken.symbol(),
      ]);

      return { ...ref, decimals, scale, symbol };
    },
    roots,
    routers,
  });
}

export async function validateConfiguredCrossCollateralGraph({
  multiProvider,
  routes,
}: {
  multiProvider: MultiProvider;
  routes: ConfiguredCrossCollateralRoute[];
}): Promise<void> {
  const descriptions = new Map<string, string>();
  const nodes = new Map<string, CrossCollateralValidationNode>();

  for (const route of routes) {
    assertConfiguredCrossCollateralRoute(route);

    for (const token of route.coreConfig.tokens) {
      assert(
        token.addressOrDenom,
        `Route "${route.id}" token on chain "${token.chainName}" is missing addressOrDenom`,
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
        scale: token.scale,
        symbol: token.symbol,
      });
    }
  }

  await validateCrossCollateralGraph({
    describeRef: (ref) =>
      descriptions.get(getCrossCollateralRouterId(ref)) ??
      describeCrossCollateralRouterRef(ref),
    loadNode: async (ref) => {
      const node = nodes.get(getCrossCollateralRouterId(ref));
      assert(
        node,
        `Missing configured CrossCollateralRouter for ${describeCrossCollateralRouterRef(ref)}`,
      );
      return node;
    },
    routers: buildConfiguredCrossCollateralRouters({ multiProvider, routes }),
  });
}

function buildConfiguredCrossCollateralRouters({
  multiProvider,
  routes,
}: {
  multiProvider: MultiProvider;
  routes: ConfiguredCrossCollateralRoute[];
}): CrossCollateralRouterReference[] {
  return dedupeCrossCollateralRouterRefs(
    routes.flatMap((route) => {
      assertConfiguredCrossCollateralRoute(route);
      return route.coreConfig.tokens.flatMap((token) => {
        assert(
          token.addressOrDenom,
          `Route "${route.id}" token on chain "${token.chainName}" is missing addressOrDenom`,
        );

        const chainConfig = route.deployConfig[token.chainName];
        assert(
          isCrossCollateralTokenConfig(chainConfig),
          `Route "${route.id}" is missing CrossCollateralRouter deploy config on chain "${token.chainName}"`,
        );

        return [
          {
            chainName: token.chainName,
            routerAddress: token.addressOrDenom,
          },
          ...Object.entries(chainConfig.crossCollateralRouters ?? {}).flatMap(
            ([domainId, routers]) => {
              const peerChainName = multiProvider.getChainName(
                Number(domainId),
              );
              return routers.map((routerAddress) => ({
                chainName: peerChainName,
                routerAddress: normalizeAddressEvm(routerAddress),
              }));
            },
          ),
        ];
      });
    }),
  );
}

function assertConsistentCrossCollateralRouters(
  nodes: CrossCollateralValidationNode[],
  describeRef: (ref: CrossCollateralRouterReference) => string,
) {
  const [baseNode, ...candidateNodes] = nodes;
  if (!baseNode) {
    return;
  }

  const baseMessageAmountTokenScale = getMessageAmountTokenScale(baseNode);

  for (const candidateNode of candidateNodes) {
    const candidateMessageAmountTokenScale =
      getMessageAmountTokenScale(candidateNode);
    const isCompatible =
      baseMessageAmountTokenScale.numerator *
        candidateMessageAmountTokenScale.denominator ===
      candidateMessageAmountTokenScale.numerator *
        baseMessageAmountTokenScale.denominator;

    assert(
      isCompatible,
      `Incompatible CrossCollateralRouter decimals/scale between ${describeRef(baseNode)} ` +
        `(${baseNode.symbol}, decimals=${baseNode.decimals}, scale=${formatCrossCollateralScaleForLogs(baseNode.scale)}) ` +
        `and ${describeRef(candidateNode)} ` +
        `(${candidateNode.symbol}, decimals=${candidateNode.decimals}, scale=${formatCrossCollateralScaleForLogs(candidateNode.scale)}).`,
    );
  }
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

function describeCrossCollateralRouterRef(
  ref: CrossCollateralRouterReference,
): string {
  return `"${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}"`;
}

function getCachedCrossCollateralNodeLoader(
  loadNode: CrossCollateralValidationNodeLoader,
): CrossCollateralValidationNodeLoader {
  const nodePromises = new Map<
    string,
    Promise<CrossCollateralValidationNode>
  >();

  return (ref) => {
    const routerId = getCrossCollateralRouterId(ref);
    const existing = nodePromises.get(routerId);
    if (existing) {
      return existing;
    }

    const next = loadNode(ref);
    nodePromises.set(routerId, next);
    return next;
  };
}

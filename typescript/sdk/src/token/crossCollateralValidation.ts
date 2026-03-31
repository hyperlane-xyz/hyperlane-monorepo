import {
  CrossCollateralRouter__factory,
  ERC20__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  assert,
  bytes32ToAddress,
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

type ExpectedCrossCollateralConfig = {
  type?: string;
  crossCollateralRouters?: Record<string, string[]>;
};

export type ConfiguredCrossCollateralRoute = {
  id: string;
  coreConfig: WarpCoreConfig;
  deployConfig: WarpRouteDeployConfig;
};

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
      if (config.type !== TokenType.crossCollateral) return [];

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

export function validateCrossCollateralGraph({
  describeRef,
  nodes,
}: {
  describeRef?: (ref: CrossCollateralRouterReference) => string;
  nodes: CrossCollateralValidationNode[];
}): void {
  const [baseNode, ...candidateNodes] = nodes;
  if (!baseNode) return;

  const describe = describeRef ?? describeCrossCollateralRouterRef;
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
      `Incompatible CrossCollateralRouter decimals/scale between ${describe(baseNode)} ` +
        `(${baseNode.symbol}, decimals=${baseNode.decimals}, scale=${formatCrossCollateralScaleForLogs(baseNode.scale)}) ` +
        `and ${describe(candidateNode)} ` +
        `(${candidateNode.symbol}, decimals=${candidateNode.decimals}, scale=${formatCrossCollateralScaleForLogs(candidateNode.scale)}).`,
    );
  }
}

export async function validateOnchainCrossCollateralGraph({
  describeRef,
  multiProvider,
  routers,
}: {
  describeRef?: (ref: CrossCollateralRouterReference) => string;
  multiProvider: MultiProvider;
  routers: CrossCollateralRouterReference[];
}): Promise<void> {
  const nodes = await Promise.all(
    dedupeCrossCollateralRouterRefs(routers).map((ref) =>
      loadOnchainCrossCollateralNode({ multiProvider, ref }),
    ),
  );

  validateCrossCollateralGraph({ describeRef, nodes });
}

export async function validateConfiguredCrossCollateralGraph({
  multiProvider,
  routes,
}: {
  multiProvider: MultiProvider;
  routes: ConfiguredCrossCollateralRoute[];
}): Promise<void> {
  const descriptions = new Map<string, string>();
  const routers = dedupeCrossCollateralRouterRefs(
    routes.flatMap((route) => {
      assertConfiguredCrossCollateralRoute(route);
      return route.coreConfig.tokens.flatMap((token) => {
        assert(
          token.addressOrDenom,
          `Route "${route.id}" token on chain "${token.chainName}" is missing addressOrDenom`,
        );

        const ref = {
          chainName: token.chainName,
          routerAddress: token.addressOrDenom,
        };
        descriptions.set(
          getCrossCollateralRouterId(ref),
          `route "${route.id}" on chain "${token.chainName}"`,
        );

        const chainConfig = route.deployConfig[token.chainName];
        assert(
          isCrossCollateralTokenConfig(chainConfig),
          `Route "${route.id}" is missing CrossCollateralRouter deploy config on chain "${token.chainName}"`,
        );

        return [
          ref,
          ...Object.entries(chainConfig.crossCollateralRouters ?? {}).flatMap(
            ([domainId, peerRouters]) => {
              const peerChainName = multiProvider.getChainName(
                Number(domainId),
              );
              return peerRouters.map((routerAddress) => ({
                chainName: peerChainName,
                routerAddress: normalizeAddressEvm(
                  bytes32ToAddress(routerAddress),
                ),
              }));
            },
          ),
        ];
      });
    }),
  );

  await validateOnchainCrossCollateralGraph({
    describeRef: (ref) =>
      descriptions.get(getCrossCollateralRouterId(ref)) ??
      describeCrossCollateralRouterRef(ref),
    multiProvider,
    routers,
  });
}

function getCrossCollateralRouterId(
  ref: CrossCollateralRouterReference,
): string {
  return `${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}`;
}

function dedupeCrossCollateralRouterRefs(
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

function formatCrossCollateralScaleForLogs(
  scale: ScaleInput | undefined,
): string {
  const normalizedScale = normalizeScale(scale);
  if (normalizedScale.denominator === 1n) {
    return normalizedScale.numerator.toString();
  }
  return `${normalizedScale.numerator}/${normalizedScale.denominator}`;
}

function getMessageAmountTokenScale({
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

async function loadOnchainCrossCollateralNode({
  multiProvider,
  ref,
}: {
  multiProvider: MultiProvider;
  ref: CrossCollateralRouterReference;
}): Promise<CrossCollateralValidationNode> {
  assert(
    isEVMLike(multiProvider.getProtocol(ref.chainName)),
    `CrossCollateralRouter validation requires an EVM chain, got "${ref.chainName}"`,
  );

  const provider = multiProvider.getProvider(ref.chainName);
  const crossCollateralRouter = CrossCollateralRouter__factory.connect(
    ref.routerAddress,
    provider,
  );
  const wrappedToken = ERC20__factory.connect(
    await crossCollateralRouter.wrappedToken(),
    provider,
  );
  const [decimals, scaleNumerator, scaleDenominator, symbol] =
    await Promise.all([
      wrappedToken.decimals(),
      crossCollateralRouter.scaleNumerator(),
      crossCollateralRouter.scaleDenominator(),
      wrappedToken.symbol(),
    ]);

  return {
    ...ref,
    decimals,
    scale: {
      numerator: BigInt(scaleNumerator.toString()),
      denominator: BigInt(scaleDenominator.toString()),
    },
    symbol,
  };
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

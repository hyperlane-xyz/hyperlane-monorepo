import {
  CrossCollateralRouter__factory,
  ERC20__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ZERO_ADDRESS_HEX_32,
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
  peers: CrossCollateralRouterReference[];
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
  roots,
  loadNode,
  describeRef,
}: {
  roots: CrossCollateralRouterReference[];
  loadNode: CrossCollateralValidationNodeLoader;
  describeRef?: (ref: CrossCollateralRouterReference) => string;
}): Promise<void> {
  if (roots.length === 0) {
    return;
  }

  const visited = new Set<string>();
  const getNode = getCachedCrossCollateralNodeLoader(loadNode);
  const describe = describeRef ?? describeCrossCollateralRouterRef;

  for (const root of dedupeCrossCollateralRouterRefs(roots)) {
    const rootRouterId = getCrossCollateralRouterId(root);
    if (visited.has(rootRouterId)) {
      continue;
    }
    const componentNodes = await collectCrossCollateralComponent({
      root,
      getNode,
      visited,
    });
    assertConsistentCrossCollateralComponent(componentNodes, describe);
  }
}

export function buildExpectedCrossCollateralConnections({
  configMap,
  multiProvider,
  routerAddresses,
}: {
  configMap: Record<string, ExpectedCrossCollateralConfig>;
  multiProvider: MultiProvider;
  routerAddresses: ChainMap<Address>;
}): Map<string, CrossCollateralRouterReference[]> {
  const expectedConnections = new Map<
    string,
    CrossCollateralRouterReference[]
  >();

  for (const [chainName, config] of Object.entries(configMap)) {
    if (
      config.type !== TokenType.crossCollateral ||
      !config.crossCollateralRouters ||
      Object.keys(config.crossCollateralRouters).length === 0
    ) {
      continue;
    }

    const routerAddress = routerAddresses[chainName];
    assert(
      routerAddress,
      `Missing CrossCollateralRouter address for chain "${chainName}"`,
    );

    expectedConnections.set(
      getCrossCollateralRouterId({ chainName, routerAddress }),
      dedupeCrossCollateralRouterRefs(
        Object.entries(
          resolveRouterMapConfig(multiProvider, config.crossCollateralRouters),
        ).flatMap(([domainId, routers]) => {
          const peerChainName = multiProvider.getChainName(Number(domainId));
          return routers.map((routerAddress) => ({
            chainName: peerChainName,
            routerAddress,
          }));
        }),
      ),
    );
  }

  return expectedConnections;
}

export async function validateOnchainCrossCollateralGraph({
  describeRef,
  expectedConnectionsByRouterId,
  multiProvider,
  roots,
}: {
  describeRef?: (ref: CrossCollateralRouterReference) => string;
  expectedConnectionsByRouterId?: Map<string, CrossCollateralRouterReference[]>;
  multiProvider: MultiProvider;
  roots: CrossCollateralRouterReference[];
}): Promise<void> {
  const readers = new Map<ChainName, EvmWarpRouteReader>();

  await validateCrossCollateralGraph({
    roots,
    describeRef,
    loadNode: async (ref) => {
      assert(
        isEVMLike(multiProvider.getProtocol(ref.chainName)),
        `CrossCollateralRouter validation requires an EVM chain, got "${ref.chainName}"`,
      );

      const provider = multiProvider.getProvider(ref.chainName);
      const crossCollateralRouter = CrossCollateralRouter__factory.connect(
        ref.routerAddress,
        provider,
      );
      const tokenRouter = TokenRouter__factory.connect(
        ref.routerAddress,
        provider,
      );
      const reader =
        readers.get(ref.chainName) ??
        new EvmWarpRouteReader(multiProvider, ref.chainName);
      readers.set(ref.chainName, reader);

      const [
        wrappedTokenAddress,
        scale,
        localDomain,
        remoteDomains,
        ccrDomains,
      ] = await Promise.all([
        crossCollateralRouter.wrappedToken(),
        reader.fetchScale(ref.routerAddress),
        crossCollateralRouter.localDomain(),
        tokenRouter.domains(),
        crossCollateralRouter.getCrossCollateralDomains(),
      ]);

      const wrappedToken = ERC20__factory.connect(
        wrappedTokenAddress,
        provider,
      );
      const [decimals, symbol] = await Promise.all([
        wrappedToken.decimals(),
        wrappedToken.symbol(),
      ]);
      const expectedPeers =
        expectedConnectionsByRouterId?.get(getCrossCollateralRouterId(ref)) ??
        [];

      return {
        ...ref,
        decimals,
        peers: dedupeCrossCollateralRouterRefs([
          ...(await getOnchainCrossCollateralPeers({
            chainName: ref.chainName,
            ccrDomains,
            crossCollateralRouter,
            localDomain,
            multiProvider,
            remoteDomains,
            tokenRouter,
          })),
          ...expectedPeers,
        ]),
        scale,
        symbol,
      };
    },
  });
}

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
      descriptions.set(
        getCrossCollateralRouterId(ref),
        `route "${route.id}" on chain "${token.chainName}"`,
      );
      nodes.set(getCrossCollateralRouterId(ref), {
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
      describeCrossCollateralRouterRef(ref),
    loadNode: async (ref) => {
      const node = nodes.get(getCrossCollateralRouterId(ref));
      assert(
        node,
        `Missing configured CrossCollateralRouter for ${describeCrossCollateralRouterRef(ref)}`,
      );
      return node;
    },
  });
}

function assertConsistentCrossCollateralComponent(
  nodes: CrossCollateralValidationNode[],
  describeRef: (ref: CrossCollateralRouterReference) => string,
) {
  if (nodes.length <= 1) {
    return;
  }

  const [baseNode, ...candidateNodes] = nodes;
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

async function collectCrossCollateralComponent({
  root,
  getNode,
  visited,
}: {
  root: CrossCollateralRouterReference;
  getNode: CrossCollateralValidationNodeLoader;
  visited: Set<string>;
}): Promise<CrossCollateralValidationNode[]> {
  const componentNodes: CrossCollateralValidationNode[] = [];
  const componentQueue = [root];

  while (componentQueue.length > 0) {
    const ref = componentQueue.shift()!;
    const routerId = getCrossCollateralRouterId(ref);
    if (visited.has(routerId)) {
      continue;
    }
    visited.add(routerId);

    const node = await getNode(ref);
    componentNodes.push(node);

    for (const peer of dedupeCrossCollateralRouterRefs(node.peers)) {
      if (!visited.has(getCrossCollateralRouterId(peer))) {
        componentQueue.push(peer);
      }
    }
  }

  return componentNodes;
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

async function getOnchainCrossCollateralPeers({
  chainName,
  ccrDomains,
  crossCollateralRouter,
  localDomain,
  multiProvider,
  remoteDomains,
  tokenRouter,
}: {
  chainName: ChainName;
  ccrDomains: number[];
  crossCollateralRouter: ReturnType<
    typeof CrossCollateralRouter__factory.connect
  >;
  localDomain: number;
  multiProvider: MultiProvider;
  remoteDomains: Array<number | bigint>;
  tokenRouter: ReturnType<typeof TokenRouter__factory.connect>;
}): Promise<CrossCollateralRouterReference[]> {
  const remoteRouters = await Promise.all(
    remoteDomains.map(async (domain) => ({
      domain: Number(domain),
      router: await tokenRouter.routers(domain),
    })),
  );

  return [
    ...remoteRouters
      .filter(({ router }) => router !== ZERO_ADDRESS_HEX_32)
      .map(({ domain, router }) =>
        toCrossCollateralRouterReference({
          chainName,
          domain,
          localDomain,
          multiProvider,
          routerBytes32: router,
        }),
      ),
    ...(
      await Promise.all(
        ccrDomains.map(async (domain) => {
          const routers =
            await crossCollateralRouter.getCrossCollateralRouters(domain);
          return routers.map((router) =>
            toCrossCollateralRouterReference({
              chainName,
              domain: Number(domain),
              localDomain,
              multiProvider,
              routerBytes32: router,
            }),
          );
        }),
      )
    ).flat(),
  ];
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

function toCrossCollateralRouterReference({
  chainName,
  domain,
  localDomain,
  multiProvider,
  routerBytes32,
}: {
  chainName: ChainName;
  domain: number;
  localDomain: number;
  multiProvider: MultiProvider;
  routerBytes32: string;
}): CrossCollateralRouterReference {
  const peerChainName =
    domain === localDomain ? chainName : multiProvider.getChainName(domain);

  return {
    chainName: peerChainName,
    routerAddress: normalizeAddressEvm(bytes32ToAddress(routerBytes32)),
  };
}

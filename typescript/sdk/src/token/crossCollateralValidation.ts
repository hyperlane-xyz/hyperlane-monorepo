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

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';

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

type ExpectedCrossCollateralConfig = {
  type?: string;
  crossCollateralRouters?: Record<string, string[]>;
};

export type CrossCollateralValidationNodeLoader = (
  ref: CrossCollateralRouterReference,
) => Promise<CrossCollateralValidationNode>;

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

export function getCanonicalWholeTokenRatio({
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

  const queue = dedupeRouterRefs(roots);
  const visited = new Set<string>();
  const nodePromises = new Map<
    string,
    Promise<CrossCollateralValidationNode>
  >();
  const describe =
    describeRef ??
    ((ref: CrossCollateralRouterReference) =>
      `"${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}"`);

  const getNode = (ref: CrossCollateralRouterReference) => {
    const routerId = getCrossCollateralRouterId(ref);
    const existing = nodePromises.get(routerId);
    if (existing) {
      return existing;
    }

    const next = loadNode(ref);
    nodePromises.set(routerId, next);
    return next;
  };

  while (queue.length > 0) {
    const ref = queue.shift()!;
    const routerId = getCrossCollateralRouterId(ref);
    if (visited.has(routerId)) {
      continue;
    }
    visited.add(routerId);

    const node = await getNode(ref);
    for (const peer of dedupeRouterRefs(node.peers)) {
      const peerNode = await getNode(peer);
      assertCompatibleCrossCollateralNodes(node, peerNode, describe);

      if (!visited.has(getCrossCollateralRouterId(peer))) {
        queue.push(peer);
      }
    }
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

    const root: CrossCollateralRouterReference = {
      chainName,
      routerAddress,
    };

    const resolvedRouters = resolveRouterMapConfig(
      multiProvider,
      config.crossCollateralRouters,
    );
    const peers: CrossCollateralRouterReference[] = [];

    for (const [domainId, routers] of Object.entries(resolvedRouters)) {
      const peerChainName = multiProvider.getChainName(Number(domainId));
      for (const peerRouter of routers) {
        peers.push({
          chainName: peerChainName,
          routerAddress: peerRouter,
        });
      }
    }

    expectedConnections.set(
      getCrossCollateralRouterId(root),
      dedupeRouterRefs(peers),
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

      const remoteRouters = await Promise.all(
        remoteDomains.map(async (domain) => ({
          domain: Number(domain),
          router: await tokenRouter.routers(domain),
        })),
      );
      const actualPeers = dedupeRouterRefs([
        ...remoteRouters
          .filter(({ router }) => router !== ZERO_ADDRESS_HEX_32)
          .map(({ domain, router }) =>
            toCrossCollateralRouterReference({
              chainName: ref.chainName,
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
                  chainName: ref.chainName,
                  domain: Number(domain),
                  localDomain,
                  multiProvider,
                  routerBytes32: router,
                }),
              );
            }),
          )
        ).flat(),
      ]);

      const expectedPeers =
        expectedConnectionsByRouterId?.get(getCrossCollateralRouterId(ref)) ??
        [];

      return {
        ...ref,
        decimals,
        peers: dedupeRouterRefs([...actualPeers, ...expectedPeers]),
        scale,
        symbol,
      };
    },
  });
}

function assertCompatibleCrossCollateralNodes(
  left: CrossCollateralValidationNode,
  right: CrossCollateralValidationNode,
  describeRef: (ref: CrossCollateralRouterReference) => string,
) {
  const leftRatio = getCanonicalWholeTokenRatio(left);
  const rightRatio = getCanonicalWholeTokenRatio(right);
  const isCompatible =
    leftRatio.numerator * rightRatio.denominator ===
    rightRatio.numerator * leftRatio.denominator;

  assert(
    isCompatible,
    `Incompatible CrossCollateralRouter decimals/scale between ${describeRef(left)} ` +
      `(${left.symbol}, decimals=${left.decimals}, scale=${formatCrossCollateralScaleForLogs(left.scale)}) ` +
      `and ${describeRef(right)} ` +
      `(${right.symbol}, decimals=${right.decimals}, scale=${formatCrossCollateralScaleForLogs(right.scale)}).`,
  );
}

function dedupeRouterRefs(
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

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

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import {
  CrossCollateralRouterReference,
  CrossCollateralValidationNode,
  dedupeCrossCollateralRouterRefs,
  getCrossCollateralRouterId,
  validateCrossCollateralGraph,
} from './crossCollateralValidation.js';
import { TokenType } from './config.js';

type ExpectedCrossCollateralConfig = {
  type?: string;
  crossCollateralRouters?: Record<string, string[]>;
};

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
      dedupeCrossCollateralRouterRefs(peers),
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
      const actualPeers = dedupeCrossCollateralRouterRefs([
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
        peers: dedupeCrossCollateralRouterRefs([
          ...actualPeers,
          ...expectedPeers,
        ]),
        scale,
        symbol,
      } satisfies CrossCollateralValidationNode;
    },
  });
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

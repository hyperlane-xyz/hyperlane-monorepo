import {
  CrossCollateralRouter__factory,
  IERC4626__factory,
  IXERC20Lockbox__factory,
  Ownable__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';
import {
  type Address,
  type ObjectDiff,
  assert,
  bytes32ToAddress,
  concurrentMap,
  deepCopy,
  diffObjMerge,
  eqAddress,
  isAddressEvm,
  isEVMLike,
  keepOnlyDiffObjects,
  normalizeAddressEvm,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { isProxy, proxyAdmin } from '../deploy/proxy.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { resolveRouterMapConfig } from '../router/types.js';
import { ChainName } from '../types.js';
import { verifyScale } from '../utils/decimals.js';
import { WarpCoreConfig } from '../warp/types.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';
import {
  expandVirtualWarpDeployConfig,
  expandWarpDeployConfig,
  getRouterAddressesFromWarpCoreConfig,
  transformConfigToCheck,
} from './configUtils.js';
import {
  DerivedWarpRouteDeployConfig,
  HypTokenRouterVirtualConfig,
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
  isCollateralTokenConfig,
  isCrossCollateralTokenConfig,
  isXERC20TokenConfig,
} from './types.js';

export const WARP_ROUTE_CHECK_TYPE = 'ConfigMismatch';
export const WARP_ROUTE_CHECK_SCALE_TYPE = 'ScaleMismatch';

type ObjectDiffMap = Exclude<ObjectDiff, ObjectDiff[] | undefined>;
type ObjectDiffLeaf = Exclude<ObjectDiffMap[string], ObjectDiff | undefined>;

export interface WarpRouteCheckViolation {
  actual: string;
  chain: ChainName;
  expected: string;
  name: string;
  type: string;
}

export interface WarpRouteCheckResult {
  diff: Record<string, ObjectDiff>;
  isValid: boolean;
  scaleViolations: WarpRouteCheckViolation[];
  violations: WarpRouteCheckViolation[];
}

type ScaleValidationWarpRouteConfig = WarpRouteDeployConfigMailboxRequired &
  Record<string, Partial<HypTokenRouterVirtualConfig>>;

type CrossCollateralRouterRef = {
  chain: string;
  metadataKey: string;
  routerAddress: string;
  routerId: string;
};

async function getWarpRouteConfigsByCore({
  multiProvider,
  warpCoreConfig,
}: {
  multiProvider: MultiProvider;
  warpCoreConfig: WarpCoreConfig;
}): Promise<DerivedWarpRouteDeployConfig> {
  const addresses = Object.fromEntries(
    warpCoreConfig.tokens.map(({ chainName, addressOrDenom }) => {
      assert(addressOrDenom, `Missing addressOrDenom for ${chainName}`);
      return [chainName, addressOrDenom];
    }),
  );

  return promiseObjAll(
    objMap(addresses, async (chain, address) => {
      const protocol = multiProvider.getProtocol(chain);
      assert(
        isEVMLike(protocol),
        `Warp route core config fetch only supports EVM chains, got ${protocol} for ${chain}`,
      );
      return new EvmWarpRouteReader(multiProvider, chain).deriveWarpRouteConfig(
        address,
      );
    }),
  );
}

export async function checkWarpRouteDeployConfig({
  multiProvider,
  warpCoreConfig,
  warpDeployConfig,
}: {
  multiProvider: MultiProvider;
  warpCoreConfig: WarpCoreConfig;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}): Promise<WarpRouteCheckResult> {
  const knownWarpCoreTokens = warpCoreConfig.tokens.filter(
    (token) => multiProvider.tryGetProtocol(token.chainName) !== null,
  );
  const evmWarpCoreConfig = {
    ...warpCoreConfig,
    tokens: knownWarpCoreTokens.filter((token) =>
      isEVMLike(multiProvider.getProtocol(token.chainName)),
    ),
  };
  assert(
    evmWarpCoreConfig.tokens.length > 0,
    'Warp route check requires at least one EVM chain in the selected route config',
  );

  const deployedRoutersAddresses = objFilter(
    getRouterAddressesFromWarpCoreConfig(warpCoreConfig),
    (chain, _address): _address is Address =>
      multiProvider.tryGetProtocol(chain) !== null,
  );
  const onChainWarpConfig = await getWarpRouteConfigsByCore({
    multiProvider,
    warpCoreConfig: evmWarpCoreConfig,
  });

  const expandedOnChainWarpConfig = await expandVirtualWarpDeployConfig({
    multiProvider,
    onChainWarpConfig,
    deployedRoutersAddresses,
  });

  const expandedWarpDeployConfig = await expandWarpDeployConfig({
    multiProvider,
    warpDeployConfig,
    deployedRoutersAddresses,
    expandedOnChainWarpConfig,
    validateScale: false,
  });
  const evmExpandedWarpDeployConfig = objFilter(
    expandedWarpDeployConfig,
    (chain, _config): _config is (typeof expandedWarpDeployConfig)[string] =>
      isEVMLike(multiProvider.getProtocol(chain)),
  );

  const rawDiff = buildWarpRouteDiff({
    onChainWarpConfig: expandedOnChainWarpConfig,
    warpRouteConfig: evmExpandedWarpDeployConfig,
  });

  await addOwnerOverrideDiffs({
    multiProvider,
    diff: rawDiff,
    warpRouteConfig: evmExpandedWarpDeployConfig,
  });

  const diff = keepOnlyDiffObjects(rawDiff) as Record<string, ObjectDiff>; // CAST: keepOnlyDiffObjects returns `any`; rawDiff is constructed as a chain-keyed ObjectDiff map
  const diffViolations = flattenWarpRouteCheckDiff(diff);
  const scaleViolations = await getScaleViolations({
    multiProvider,
    warpRouteConfig: expandedWarpDeployConfig,
  });

  return {
    diff,
    isValid: diffViolations.length === 0 && scaleViolations.length === 0,
    scaleViolations,
    violations: [...diffViolations, ...scaleViolations],
  };
}

function buildWarpRouteDiff({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
  onChainWarpConfig: DerivedWarpRouteDeployConfig &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
}): Record<string, ObjectDiff> {
  return Object.keys(warpRouteConfig).reduce(
    (acc, chain) => {
      const expectedDeployedConfig = deepCopy(warpRouteConfig[chain]);
      const currentDeployedConfig = deepCopy(onChainWarpConfig[chain]);

      if (!currentDeployedConfig) {
        acc[chain] = {
          route: {
            actual: 'missing',
            expected: 'present',
          },
        };
        return acc;
      }

      if (typeof expectedDeployedConfig.hook === 'string') {
        currentDeployedConfig.hook = derivedHookAddress(currentDeployedConfig);
      }

      if (typeof expectedDeployedConfig.interchainSecurityModule === 'string') {
        currentDeployedConfig.interchainSecurityModule = derivedIsmAddress(
          currentDeployedConfig,
        );
      }

      if (!expectedDeployedConfig.contractVersion) {
        currentDeployedConfig.contractVersion = undefined;
      }

      if (!expectedDeployedConfig.proxyAdmin?.address) {
        currentDeployedConfig.proxyAdmin = currentDeployedConfig.proxyAdmin
          ? { ...currentDeployedConfig.proxyAdmin, address: undefined }
          : undefined;
      }

      const { mergedObject, isInvalid } = diffObjMerge(
        transformConfigToCheck(currentDeployedConfig),
        transformConfigToCheck(expectedDeployedConfig),
      );

      if (isInvalid) {
        acc[chain] = mergedObject;
      }

      return acc;
    },
    {} as Record<string, ObjectDiff>, // CAST: reduce incrementally populates chain-keyed ObjectDiff entries
  );
}

async function addOwnerOverrideDiffs({
  multiProvider,
  diff,
  warpRouteConfig,
}: {
  multiProvider: MultiProvider;
  diff: Record<string, ObjectDiff>;
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
}) {
  for (const [chain, config] of Object.entries(warpRouteConfig)) {
    const ownerOverrides = config.ownerOverrides;
    if (!ownerOverrides || !isEVMLike(multiProvider.getProtocol(chain))) {
      continue;
    }

    const provider = multiProvider.getProvider(chain);

    if (ownerOverrides.collateralToken) {
      const collateralToken = await getCollateralOwnable(config, provider);
      if (collateralToken) {
        const actualOwner = await collateralToken.owner();
        if (!eqAddress(actualOwner, ownerOverrides.collateralToken)) {
          addNestedDiff(diff, chain, ['ownerOverrides', 'collateralToken'], {
            actual: actualOwner,
            expected: ownerOverrides.collateralToken,
          });
        }
      }
    }

    if (ownerOverrides.collateralProxyAdmin) {
      const collateralTokenAddress = await getCollateralTokenAddress(
        config,
        provider,
      );
      if (
        collateralTokenAddress &&
        (await isProxy(provider, collateralTokenAddress))
      ) {
        const collateralProxyAdminAddress = await proxyAdmin(
          provider,
          collateralTokenAddress,
        );
        const actualOwner = await ProxyAdmin__factory.connect(
          collateralProxyAdminAddress,
          provider,
        ).owner();
        if (!eqAddress(actualOwner, ownerOverrides.collateralProxyAdmin)) {
          addNestedDiff(
            diff,
            chain,
            ['ownerOverrides', 'collateralProxyAdmin'],
            {
              actual: actualOwner,
              expected: ownerOverrides.collateralProxyAdmin,
            },
          );
        }
      }
    }
  }
}

async function getCollateralTokenAddress(
  config: WarpRouteDeployConfigMailboxRequired[string],
  provider: ReturnType<MultiProvider['getProvider']>,
): Promise<string | undefined> {
  if (isXERC20TokenConfig(config)) {
    if (config.type === TokenType.XERC20Lockbox) {
      return IXERC20Lockbox__factory.connect(config.token, provider).callStatic[
        'XERC20()'
      ]();
    }

    return config.token;
  }

  if (isCollateralTokenConfig(config) || isCrossCollateralTokenConfig(config)) {
    if (
      config.type === TokenType.collateralVault ||
      config.type === TokenType.collateralVaultRebase
    ) {
      return IERC4626__factory.connect(config.token, provider).asset();
    }

    return config.token;
  }

  return undefined;
}

async function getCollateralOwnable(
  config: WarpRouteDeployConfigMailboxRequired[string],
  provider: ReturnType<MultiProvider['getProvider']>,
) {
  // Preserve legacy checker behavior: only the XERC20 collateral side is
  // assumed to expose Ownable for explicit collateralToken override checks.
  if (!isXERC20TokenConfig(config)) {
    return undefined;
  }

  const collateralTokenAddress = await getCollateralTokenAddress(
    config,
    provider,
  );
  return collateralTokenAddress
    ? Ownable__factory.connect(collateralTokenAddress, provider)
    : undefined;
}

function addNestedDiff(
  diff: Record<string, ObjectDiff>,
  chain: string,
  path: string[],
  value: ObjectDiffLeaf,
) {
  if (!diff[chain]) {
    diff[chain] = {};
  }

  let cursor = diff[chain];
  assertObjectDiffMap(
    cursor,
    `Unexpected leaf diff for ${chain}; refusing to overwrite it`,
  );

  for (const key of path.slice(0, -1)) {
    if (!cursor[key]) {
      cursor[key] = {};
    }

    const nextCursor: unknown = cursor[key];
    assertObjectDiffMap(
      nextCursor,
      `Unexpected leaf diff for ${chain}.${key}; refusing to overwrite it`,
    );
    cursor = nextCursor;
  }

  cursor[path[path.length - 1]] = value;
}

function flattenWarpRouteCheckDiff(
  diff: Record<string, ObjectDiff>,
): WarpRouteCheckViolation[] {
  return Object.entries(diff).flatMap(([chain, chainDiff]) =>
    flattenDiffNode(chain, chainDiff, []),
  );
}

function flattenDiffNode(
  chain: ChainName,
  value: unknown,
  path: string[],
): WarpRouteCheckViolation[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      flattenDiffNode(chain, item, [...path, index.toString()]),
    );
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>; // CAST: runtime guard above narrows to object; Object.entries needs an indexable shape
    const childViolations = Object.entries(objectValue)
      .filter(([key]) => key !== 'actual' && key !== 'expected')
      .flatMap(([key, child]) => flattenDiffNode(chain, child, [...path, key]));

    if (childViolations.length > 0) {
      return childViolations;
    }

    if (isObjectDiffLeaf(value)) {
      return [
        {
          actual: stringifyViolationValue(value.actual),
          chain,
          expected: stringifyViolationValue(value.expected),
          name: path.join('.'),
          type: WARP_ROUTE_CHECK_TYPE,
        },
      ];
    }

    return [];
  }

  return [];
}

function collectConfiguredCrossCollateralRouters({
  multiProvider,
  warpRouteConfig,
}: {
  multiProvider: MultiProvider;
  warpRouteConfig: ScaleValidationWarpRouteConfig;
}): CrossCollateralRouterRef[] {
  const routerRefs = new Map<string, CrossCollateralRouterRef>();

  for (const config of Object.values(warpRouteConfig)) {
    if (
      !isCrossCollateralTokenConfig(config) ||
      !config.crossCollateralRouters
    ) {
      continue;
    }

    const crossCollateralRouters = resolveRouterMapConfig(
      multiProvider,
      config.crossCollateralRouters,
    );

    for (const [domain, routers] of Object.entries(crossCollateralRouters)) {
      const chain = multiProvider.tryGetChainName(Number(domain));
      if (!chain || !isEVMLike(multiProvider.getProtocol(chain))) {
        continue;
      }

      for (const routerId of routers) {
        const routerAddress = normalizeAddressEvm(
          isAddressEvm(routerId) ? routerId : bytes32ToAddress(routerId),
        );
        const metadataKey = `${chain}:${routerAddress.toLowerCase()}`;
        routerRefs.set(metadataKey, {
          chain,
          metadataKey,
          routerAddress,
          routerId,
        });
      }
    }
  }

  return [...routerRefs.values()];
}

async function fetchConfiguredCrossCollateralRouterMetadata({
  multiProvider,
  readerByChain,
  routerRef,
}: {
  multiProvider: MultiProvider;
  readerByChain: Map<string, EvmWarpRouteReader>;
  routerRef: CrossCollateralRouterRef;
}): Promise<readonly [string, TokenMetadata]> {
  const { chain, metadataKey, routerAddress, routerId } = routerRef;
  const reader =
    readerByChain.get(chain) ?? new EvmWarpRouteReader(multiProvider, chain);
  readerByChain.set(chain, reader);

  try {
    const crossCollateralRouter = CrossCollateralRouter__factory.connect(
      routerAddress,
      multiProvider.getProvider(chain),
    );
    const [wrappedTokenAddress, scale] = await Promise.all([
      crossCollateralRouter.wrappedToken(),
      reader.fetchScale(routerAddress),
    ]);
    const metadata = await reader.fetchERC20Metadata(wrappedTokenAddress);

    return [metadataKey, { ...metadata, scale }] as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to derive configured crossCollateral router ${routerId} on ${chain}: ${message}`,
    );
  }
}

async function buildScaleValidationMetadataMap({
  multiProvider,
  warpRouteConfig,
}: {
  multiProvider: MultiProvider;
  warpRouteConfig: ScaleValidationWarpRouteConfig;
}): Promise<Map<string, TokenMetadata>> {
  const metadataByKey = new Map<string, TokenMetadata>(
    Object.entries(warpRouteConfig).map(([chain, config]) => [
      chain,
      {
        decimals: config.decimals,
        name: config.name ?? 'unknown',
        scale: config.scale,
        symbol: config.symbol ?? 'unknown',
      },
    ]),
  );

  const readerByChain = new Map<string, EvmWarpRouteReader>();
  const configuredRouters = collectConfiguredCrossCollateralRouters({
    multiProvider,
    warpRouteConfig,
  });
  const configuredRouterMetadata = await concurrentMap(
    6,
    configuredRouters,
    async (routerRef) =>
      fetchConfiguredCrossCollateralRouterMetadata({
        multiProvider,
        readerByChain,
        routerRef,
      }),
  );

  for (const [metadataKey, metadata] of configuredRouterMetadata) {
    metadataByKey.set(metadataKey, metadata);
  }

  return metadataByKey;
}

export async function getScaleViolations({
  multiProvider,
  warpRouteConfig,
}: {
  multiProvider: MultiProvider;
  warpRouteConfig: ScaleValidationWarpRouteConfig;
}): Promise<WarpRouteCheckViolation[]> {
  const scaleValidationMetadata = await buildScaleValidationMetadataMap({
    multiProvider,
    warpRouteConfig,
  });

  if (verifyScale(scaleValidationMetadata)) {
    return [];
  }

  return [
    {
      actual: 'invalid-or-missing',
      chain: 'route',
      expected: 'consistent-with-decimals',
      name: 'scale',
      type: WARP_ROUTE_CHECK_SCALE_TYPE,
    },
  ];
}

function stringifyViolationValue(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === undefined) {
    return '';
  }

  if (value === null || typeof value !== 'object') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stringifyViolationValue).join(',')}]`;
  }

  return `{${Object.entries(value)
    .map(([key, child]) => `${key}:${stringifyViolationValue(child)}`)
    .join(',')}}`;
}

function isObjectDiffLeaf(value: unknown): value is ObjectDiffLeaf {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'actual' in value &&
    'expected' in value
  );
}

function isObjectDiffMap(value: unknown): value is ObjectDiffMap {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isObjectDiffLeaf(value)
  );
}

function assertObjectDiffMap(
  value: unknown,
  message: string,
): asserts value is ObjectDiffMap {
  assert(isObjectDiffMap(value), message);
}

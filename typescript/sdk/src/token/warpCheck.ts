import {
  CrossCollateralRouter__factory,
  IERC4626__factory,
  IXERC20Lockbox__factory,
  Ownable__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';
import {
  createWarpTokenReader,
  loadProtocolProviders,
} from '@hyperlane-xyz/deploy-sdk';
import type { DerivedWarpConfig } from '@hyperlane-xyz/provider-sdk/warp';
import {
  type Address,
  type ObjectDiff,
  ProtocolType,
  assert,
  bytes32ToAddress,
  concurrentMap,
  deepCopy,
  diffObjMerge,
  eqAddress,
  isAddressEvm,
  isEVMLike,
  isNullish,
  keepOnlyDiffObjects,
  normalizeAddressEvm,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { isProxy, proxyAdmin } from '../deploy/proxy.js';
import { altVmChainLookup } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { resolveRouterMapConfig } from '../router/types.js';
import { ChainName } from '../types.js';
import { normalizeScale, verifyScale } from '../utils/decimals.js';
import { WarpCoreConfig } from '../warp/types.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';
import {
  expandVirtualWarpDeployConfig,
  expandWarpDeployConfig,
  getRouterAddressesFromWarpCoreConfig,
  normalizeWarpDeployConfigForCheck,
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

// Normalized shape used for altVM diff comparison.
// All router addresses are lowercased bytes32 hex. Keys are chain names.
type AltVmCheckConfig = {
  type: string;
  owner: string;
  mailbox: string;
  interchainSecurityModule?: string;
  hook?: string;
  scale?: number;
  remoteRouters: Record<string, string>;
  destinationGas: Record<string, string>;
  token?: string;
  name?: string;
  symbol?: string;
  decimals?: number;
};

function hasAddress(value: unknown): value is { address: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    'address' in value &&
    typeof (value as { address: unknown }).address === 'string'
  );
}

function extractAddress(
  value:
    | DerivedWarpConfig['interchainSecurityModule']
    | DerivedWarpConfig['hook'],
): string | undefined {
  if (typeof value === 'string') return value;
  if (hasAddress(value)) return value.address;
  return undefined;
}

function derivedWarpConfigToCheckConfig(
  config: DerivedWarpConfig,
): AltVmCheckConfig {
  const remoteRouters: Record<string, string> = {};
  for (const [chain, router] of Object.entries(config.remoteRouters)) {
    remoteRouters[chain] = router.address.toLowerCase();
  }

  const destinationGas: Record<string, string> = {};
  for (const [chain, gas] of Object.entries(config.destinationGas)) {
    destinationGas[chain] = gas;
  }

  const result: AltVmCheckConfig = {
    type: config.type,
    owner: config.owner,
    mailbox: config.mailbox,
    interchainSecurityModule: extractAddress(config.interchainSecurityModule),
    hook: extractAddress(config.hook),
    scale: config.scale,
    remoteRouters,
    destinationGas,
  };

  // warpArtifactToDerivedConfig spreads name/symbol/decimals from baseDerivedConfig
  // even onto DerivedNativeWarpConfig at runtime. Mirror the expected-side guards:
  // only include fields that can be non-undefined, and skip name/symbol for native.
  // The `type !== native` check above narrows away DerivedNativeWarpConfig, so
  // name/symbol are accessible without a cast; decimals is checked unconditionally
  // below (DerivedNativeWarpConfig has no decimals field), so a narrowing `in` check
  // is used instead.
  if (config.type !== TokenType.native) {
    if (!isNullish(config.name)) result.name = config.name;
    if (!isNullish(config.symbol)) result.symbol = config.symbol;
  }
  const decimals = 'decimals' in config ? config.decimals : undefined;
  if (!isNullish(decimals)) result.decimals = decimals;
  if ('token' in config && typeof config.token === 'string') {
    result.token = config.token;
  }

  return result;
}

function expandedDeployConfigToAltVmCheckConfig(
  chain: ChainName,
  config: WarpRouteDeployConfigMailboxRequired[string],
  multiProvider: MultiProvider,
): AltVmCheckConfig {
  const remoteRouters: Record<string, string> = {};
  for (const [domainIdStr, router] of Object.entries(
    config.remoteRouters ?? {},
  )) {
    const chainName = multiProvider.tryGetChainName(parseInt(domainIdStr));
    // An unresolvable domain ID must not be silently dropped -- that would let a
    // typo'd or unknown remoteRouters/destinationGas domain vanish from the
    // expected side entirely, and since the derived side won't have a matching
    // entry either, the mismatch would never surface as a diff.
    assert(
      chainName,
      `Unknown remoteRouters domain ${domainIdStr} configured for chain ${chain}`,
    );
    remoteRouters[chainName] = router.address.toLowerCase();
  }

  const destinationGas: Record<string, string> = {};
  for (const [domainIdStr, gas] of Object.entries(
    config.destinationGas ?? {},
  )) {
    const chainName = multiProvider.tryGetChainName(parseInt(domainIdStr));
    assert(
      chainName,
      `Unknown destinationGas domain ${domainIdStr} configured for chain ${chain}`,
    );
    destinationGas[chainName] = gas;
  }

  // Only compare ISM/hook as addresses when they are plain strings in the deploy config.
  // Complex ISM/hook config objects require deployment to resolve their address,
  // so we skip comparison for those to avoid false violations.
  const ismAddress =
    typeof config.interchainSecurityModule === 'string'
      ? config.interchainSecurityModule
      : undefined;
  const hookAddress = typeof config.hook === 'string' ? config.hook : undefined;

  // The derived (on-chain) side's scale is always a plain number, so a fractional
  // scale can only be compared once it collapses to an exact integer ratio.
  // Converting via `Number(bigint) / Number(bigint)` for a non-evenly-dividing
  // fraction would silently produce a lossy float that can never match the
  // derived side, causing a false-positive ScaleMismatch -- so those are left
  // undefined (skipped) instead. An unset config.scale is left undefined too,
  // matching the derived side's convention of `undefined` for identity scale.
  let scale: number | undefined;
  if (!isNullish(config.scale)) {
    const normalizedScale = normalizeScale(config.scale);
    if (normalizedScale.numerator % normalizedScale.denominator === 0n) {
      scale = Number(normalizedScale.numerator / normalizedScale.denominator);
    }
  }

  const result: AltVmCheckConfig = {
    type: config.type,
    owner: config.owner,
    mailbox: config.mailbox,
    interchainSecurityModule: ismAddress,
    hook: hookAddress,
    scale,
    remoteRouters,
    destinationGas,
  };

  // deriveTokenMetadata is EVM-only, so name/symbol/decimals are undefined in the
  // expanded deploy config for non-EVM chains unless the user explicitly set them.
  // Only include them in the comparison when they're actually specified, to avoid
  // false positives from unresolved metadata on the expected side.
  // name/symbol are also skipped for native tokens — they're not stored on-chain.
  if (config.type !== TokenType.native) {
    if (!isNullish(config.name)) result.name = config.name;
    if (!isNullish(config.symbol)) result.symbol = config.symbol;
  }
  if (!isNullish(config.decimals)) result.decimals = config.decimals;

  if ('token' in config && typeof config.token === 'string') {
    result.token = config.token;
  }

  return result;
}

async function getAltVmOnChainConfigs({
  multiProvider,
  warpCoreConfig,
}: {
  multiProvider: MultiProvider;
  warpCoreConfig: WarpCoreConfig;
}): Promise<Record<string, AltVmCheckConfig>> {
  const altVmTokens = warpCoreConfig.tokens.filter((token) => {
    const protocol = multiProvider.tryGetProtocol(token.chainName);
    return protocol !== null && !isEVMLike(protocol);
  });

  if (altVmTokens.length === 0) return {};

  // createWarpTokenReader relies on a protocol provider having been registered
  // for each altVM chain's protocol; loadProtocolProviders is idempotent (skips
  // protocols that are already loaded), so it's safe to call unconditionally here
  // rather than relying on call-site ordering by the consumer.
  await loadProtocolProviders(
    new Set(
      altVmTokens.map(
        ({ chainName }) => multiProvider.getProtocol(chainName) as ProtocolType,
      ),
    ),
  );

  const chainLookup = altVmChainLookup(multiProvider);

  return promiseObjAll(
    Object.fromEntries(
      altVmTokens.map(({ chainName, addressOrDenom }) => {
        assert(addressOrDenom, `Missing addressOrDenom for ${chainName}`);
        const chainMetadata = chainLookup.getChainMetadata(chainName);
        const reader = createWarpTokenReader(chainMetadata, chainLookup);
        return [
          chainName,
          (async () => {
            try {
              const config = await reader.deriveWarpConfig(addressOrDenom);
              return derivedWarpConfigToCheckConfig(config);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `Failed to derive altVM warp config for ${chainName} at ${addressOrDenom}: ${message}`,
              );
            }
          })(),
        ];
      }),
    ),
  );
}

function buildAltVmWarpRouteDiff(
  onChainConfigs: Record<string, AltVmCheckConfig>,
  expectedConfigs: Record<string, AltVmCheckConfig>,
): Record<string, ObjectDiff> {
  const diff: Record<string, ObjectDiff> = {};

  for (const chain of Object.keys(expectedConfigs)) {
    const expected = expectedConfigs[chain];
    const actual = onChainConfigs[chain];

    if (!actual) {
      diff[chain] = { route: { actual: 'missing', expected: 'present' } };
      continue;
    }

    // The on-chain reader always resolves ISM/hook to a concrete address (the zero
    // address when unset), but the expected side only has a string when the deploy
    // config explicitly specifies a plain-address ISM/hook (see
    // expandedDeployConfigToAltVmCheckConfig). Comparing the resolved zero address
    // against an omitted expected value would otherwise report a false-positive
    // mismatch on every altVM route that doesn't override ISM/hook -- mirror the
    // EVM path (buildWarpRouteDiff) and only compare when both sides opt in.
    const normalizedActual: AltVmCheckConfig = {
      ...actual,
      interchainSecurityModule: isNullish(expected.interchainSecurityModule)
        ? undefined
        : actual.interchainSecurityModule,
      hook: isNullish(expected.hook) ? undefined : actual.hook,
    };

    const { mergedObject, isInvalid } = diffObjMerge(
      normalizedActual,
      expected,
    );

    if (isInvalid) {
      diff[chain] = mergedObject;
    }
  }

  // A chain present on-chain but absent from the expected config (e.g. removed
  // from the deploy config while the warp-core registry still lists it) must not
  // be silently invisible to `warp check`.
  for (const chain of Object.keys(onChainConfigs)) {
    if (!(chain in expectedConfigs)) {
      diff[chain] = { route: { actual: 'present', expected: 'missing' } };
    }
  }

  return diff;
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
  const normalizedWarpDeployConfig = normalizeWarpDeployConfigForCheck({
    multiProvider,
    warpDeployConfig: expandedWarpDeployConfig,
  });
  const evmExpandedWarpDeployConfig = objFilter(
    normalizedWarpDeployConfig,
    (chain, _config): _config is (typeof expandedWarpDeployConfig)[string] =>
      isEVMLike(multiProvider.getProtocol(chain)),
  );

  const rawEvmDiff = buildWarpRouteDiff({
    onChainWarpConfig: expandedOnChainWarpConfig,
    warpRouteConfig: evmExpandedWarpDeployConfig,
  });

  await addOwnerOverrideDiffs({
    multiProvider,
    diff: rawEvmDiff,
    warpRouteConfig: evmExpandedWarpDeployConfig,
  });

  // AltVM check: read on-chain state and diff against the expanded deploy config
  const altVmOnChainConfigs = await getAltVmOnChainConfigs({
    multiProvider,
    warpCoreConfig,
  });

  const altVmExpectedConfigs: Record<string, AltVmCheckConfig> = {};
  for (const [chain, config] of Object.entries(normalizedWarpDeployConfig)) {
    if (!isEVMLike(multiProvider.getProtocol(chain))) {
      altVmExpectedConfigs[chain] = expandedDeployConfigToAltVmCheckConfig(
        chain,
        config,
        multiProvider,
      );
    }
  }

  const rawAltVmDiff = buildAltVmWarpRouteDiff(
    altVmOnChainConfigs,
    altVmExpectedConfigs,
  );

  const rawDiff = {
    ...rawEvmDiff,
    ...rawAltVmDiff,
  };

  const diff = keepOnlyDiffObjects(rawDiff) as Record<string, ObjectDiff>; // CAST: keepOnlyDiffObjects returns `any`; rawDiff is constructed as a chain-keyed ObjectDiff map
  const diffViolations = flattenWarpRouteCheckDiff(diff);
  const scaleViolations = await getScaleViolations({
    multiProvider,
    warpRouteConfig: normalizedWarpDeployConfig,
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

  if (typeof value === 'string') {
    return value;
  }

  if (value === null) {
    return 'null';
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    return value.toString();
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

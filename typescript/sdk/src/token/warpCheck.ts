import { zeroAddress } from 'viem';

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
  addressToBytes32,
  assert,
  bytes32ToAddress,
  concurrentMap,
  deepCopy,
  diffObjMerge,
  eqAddress,
  isAddressEvm,
  isCosmosIbcDenomAddress,
  isEVMLike,
  isNullish,
  keepOnlyDiffObjects,
  normalizeAddress,
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
import {
  type ScaleInput,
  scalesEqual,
  verifyScale,
} from '../utils/decimals.js';
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

// Protocols createWarpTokenReader/loadProtocolProviders actually support. Not every
// non-EVM protocol is a checkable altVM: e.g. legacy (non-native) Cosmos SDK chains
// have no registered protocol provider and no warp token reader, so treating them
// as "altVM" would attempt an on-chain read that always throws. Keep this in sync
// with the switch in `@hyperlane-xyz/deploy-sdk`'s loadProtocolProviders.
const ALTVM_CHECK_PROTOCOLS: ReadonlySet<ProtocolType> = new Set([
  ProtocolType.CosmosNative,
  ProtocolType.Radix,
  ProtocolType.Aleo,
  ProtocolType.Sealevel,
  ProtocolType.Starknet,
]);

function isSupportedAltVmProtocol(protocol: ProtocolType | null): boolean {
  return protocol !== null && ALTVM_CHECK_PROTOCOLS.has(protocol);
}

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
// name/symbol are deliberately excluded, mirroring the EVM path's
// FIELDS_TO_IGNORE (see configUtils.ts): they're not critical to whether the
// route functions correctly, and some altVM protocols (Cosmos SDK) don't
// store them on-chain at all, so comparing them produces false positives.
export type AltVmCheckConfig = {
  type: string;
  owner: string;
  mailbox: string;
  interchainSecurityModule?: string;
  hook?: string;
  scale?: number;
  remoteRouters: Record<string, string>;
  destinationGas: Record<string, string>;
  token?: string;
  decimals?: number;
  contractVersion?: string;
  crossCollateralRouters?: Record<string, string[]>;
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

export function derivedWarpConfigToCheckConfig(
  config: DerivedWarpConfig,
  protocol: ProtocolType,
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
    owner: normalizeAddress(config.owner, protocol),
    mailbox: normalizeAddress(config.mailbox, protocol),
    interchainSecurityModule: normalizeOptionalAddress(
      extractAddress(config.interchainSecurityModule),
      protocol,
    ),
    hook: normalizeOptionalAddress(extractAddress(config.hook), protocol),
    scale: config.scale,
    remoteRouters,
    destinationGas,
  };

  // Cosmos SDK chains don't store token metadata on-chain and the reader
  // always returns a decimals=0 placeholder (see cosmos-sdk's warp-query.ts);
  // comparing it would produce a false-positive mismatch against any real
  // configured decimals, so it's excluded for that protocol only.
  // DerivedNativeWarpConfig has no decimals field, hence the `in` check.
  const decimals = 'decimals' in config ? config.decimals : undefined;
  if (protocol !== ProtocolType.CosmosNative && !isNullish(decimals)) {
    result.decimals = decimals;
  }
  if ('token' in config && typeof config.token === 'string') {
    result.token = normalizeAddress(config.token, protocol);
  }
  if (!isNullish(config.contractVersion)) {
    result.contractVersion = config.contractVersion;
  }
  if ('crossCollateralRouters' in config) {
    result.crossCollateralRouters = normalizeCrossCollateralRouters(
      config.crossCollateralRouters,
    );
  }

  return result;
}

function normalizeOptionalAddress(
  address: string | undefined,
  protocol: ProtocolType,
): string | undefined {
  return address === undefined
    ? undefined
    : normalizeAddress(address, protocol);
}

// Cross-collateral router addresses are always bytes32 on-chain, but a deploy
// config listing an EVM remote may write it as a plain 20-byte address --
// widen it before lowercasing so it compares equal to the padded on-chain form.
function normalizeCrossCollateralRouterAddress(address: string): string {
  return (
    isAddressEvm(address) ? addressToBytes32(address) : address
  ).toLowerCase();
}

// SVM cross-collateral readers always include `crossCollateralRouters` (even
// as `{}` when nothing is enrolled), but the expected side only sets it when
// the deploy config specifies it -- normalize both sides so an empty map is
// equivalent to omitted, rather than diffing `{}` against `undefined`.
function normalizeCrossCollateralRouters(
  routers: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!routers) return undefined;
  const normalized = objMap(routers, (_chain, addresses) =>
    [...addresses].map(normalizeCrossCollateralRouterAddress).sort(),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function expandedDeployConfigToAltVmCheckConfig(
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

  const protocol = multiProvider.getProtocol(chain);

  // Only compare ISM/hook as addresses when they are plain strings in the deploy config.
  // Complex ISM/hook config objects require deployment to resolve their address,
  // so we skip comparison for those to avoid false violations. expandWarpDeployConfig
  // also fills in viem's EVM `zeroAddress` as the default for any chain (including
  // altVM ones) that doesn't set ISM/hook at all -- that placeholder isn't a genuine
  // user-specified value for a non-EVM chain (whose real "unset" sentinel, if any,
  // looks nothing like an EVM zero address), so it's treated the same as unset here
  // too, rather than being diffed against the real on-chain address.
  const ismAddress =
    typeof config.interchainSecurityModule === 'string' &&
    config.interchainSecurityModule !== zeroAddress
      ? normalizeAddress(config.interchainSecurityModule, protocol)
      : undefined;
  const hookAddress =
    typeof config.hook === 'string' && config.hook !== zeroAddress
      ? normalizeAddress(config.hook, protocol)
      : undefined;

  // scale is deliberately left unset here -- it's compared separately via
  // altVmScaleMismatch (exact bigint fraction compare against the raw expected
  // config.scale), not through this generic diff. See checkWarpRouteDeployConfig.
  const result: AltVmCheckConfig = {
    type: config.type,
    owner: normalizeAddress(config.owner, protocol),
    mailbox: normalizeAddress(config.mailbox, protocol),
    interchainSecurityModule: ismAddress,
    hook: hookAddress,
    remoteRouters,
    destinationGas,
  };

  // deriveTokenMetadata is EVM-only, so decimals is undefined in the expanded
  // deploy config for non-EVM chains unless the user explicitly set it or it was
  // seeded from on-chain state (see metadataSeededWarpDeployConfig below). Only
  // include it in the comparison when it's actually specified, to avoid false
  // positives from unresolved metadata on the expected side. Cosmos SDK's
  // decimals=0 placeholder is excluded on the actual side (see
  // derivedWarpConfigToCheckConfig), so it's excluded here too for symmetry.
  if (protocol !== ProtocolType.CosmosNative && !isNullish(config.decimals)) {
    result.decimals = config.decimals;
  }

  if ('token' in config && typeof config.token === 'string') {
    result.token = normalizeAddress(config.token, protocol);
  }

  if (!isNullish(config.contractVersion)) {
    result.contractVersion = config.contractVersion;
  }

  if (isCrossCollateralTokenConfig(config) && config.crossCollateralRouters) {
    const resolvedByDomain = resolveRouterMapConfig(
      multiProvider,
      config.crossCollateralRouters,
    );
    const crossCollateralRouters: Record<string, string[]> = {};
    for (const [domainIdStr, routers] of Object.entries(resolvedByDomain)) {
      const chainName = multiProvider.tryGetChainName(Number(domainIdStr));
      assert(
        chainName,
        `Unknown crossCollateralRouters domain ${domainIdStr} configured for chain ${chain}`,
      );
      crossCollateralRouters[chainName] = [...routers];
    }
    result.crossCollateralRouters = normalizeCrossCollateralRouters(
      crossCollateralRouters,
    );
  }

  return result;
}

// Fetches raw on-chain altVM warp configs (pre-diff-shape). Kept separate from
// the AltVmCheckConfig conversion so callers can also read name/symbol/decimals
// off the raw config for metadata seeding (see metadataSeededWarpDeployConfig
// in checkWarpRouteDeployConfig) before those fields are dropped for diffing.
async function getAltVmOnChainDerivedConfigs({
  multiProvider,
  warpCoreConfig,
}: {
  multiProvider: MultiProvider;
  warpCoreConfig: WarpCoreConfig;
}): Promise<Record<string, DerivedWarpConfig>> {
  const altVmTokens = warpCoreConfig.tokens.filter(
    (token) =>
      isSupportedAltVmProtocol(multiProvider.tryGetProtocol(token.chainName)) &&
      // ibc/... denoms live on the same chain as the warp token but are only
      // used to pay the IGP hook -- they aren't routers and deriving a warp
      // config against one always fails (mirrors getRouterAddressesFromWarpCoreConfig).
      !isCosmosIbcDenomAddress(token.addressOrDenom),
  );

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
              return await reader.deriveWarpConfig(addressOrDenom);
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

export function buildAltVmWarpRouteDiff(
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
    // contractVersion is excluded the same way (mirrors buildWarpRouteDiff): it's
    // rarely set explicitly, so only compare when the deploy config opts in.
    // scale is excluded entirely here -- it needs an exact rational comparison
    // (see altVmScaleMismatch) rather than the plain `number` diffObjMerge does.
    const normalizedActual: AltVmCheckConfig = {
      ...actual,
      interchainSecurityModule: isNullish(expected.interchainSecurityModule)
        ? undefined
        : actual.interchainSecurityModule,
      hook: isNullish(expected.hook) ? undefined : actual.hook,
      contractVersion: isNullish(expected.contractVersion)
        ? undefined
        : actual.contractVersion,
      scale: undefined,
    };
    const normalizedExpected: AltVmCheckConfig = {
      ...expected,
      scale: undefined,
    };

    const { mergedObject, isInvalid } = diffObjMerge(
      normalizedActual,
      normalizedExpected,
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

// The derived (on-chain) side's scale can itself be a non-integer number (e.g.
// SVM's remoteDecimalsToScale returns 10^(remoteDecimals - localDecimals),
// which is fractional whenever the remote chain has fewer decimals). Convert it
// to an exact bigint fraction so it can be compared against the expected side's
// fraction via `scalesEqual` without floating-point precision loss in either
// direction. Scale ratios are always clean powers of ten in practice, so an
// exact integer reciprocal is expected to exist; this intentionally throws if
// it doesn't rather than silently comparing a rounded approximation.
function actualScaleToScaleInput(scale: number): ScaleInput {
  if (Number.isInteger(scale)) return scale;
  // `1 / scale` is lossy for powers of ten with a large negative exponent
  // (e.g. scale=1e-5 -> inverse=99999.99999999999, scale=1e-18 -> inverse
  // rounds to an integer that isn't exactly 10^18) -- reconstruct the exponent
  // via log10 and verify by exact recomputation instead of dividing.
  const exponent = Math.round(Math.log10(scale));
  assert(
    Math.pow(10, exponent) === scale,
    `AltVM on-chain scale ${scale} is not exactly representable as a power-of-ten ratio`,
  );
  return { numerator: 1n, denominator: 10n ** BigInt(-exponent) };
}

// Compares the on-chain scale against the raw (pre-expansion) expected
// config.scale using exact bigint cross-multiplication (via `scalesEqual`)
// instead of the lossy float collapse this used to do. Deliberately kept
// outside of AltVmCheckConfig/buildAltVmWarpRouteDiff's generic diff, since it
// needs the un-collapsed expected fraction, not a pre-converted plain number.
export function altVmScaleMismatch(
  actualScale: number | undefined,
  expectedScale: WarpRouteDeployConfigMailboxRequired[string]['scale'],
): { actual: string; expected: string } | undefined {
  const actualInput =
    actualScale === undefined
      ? undefined
      : actualScaleToScaleInput(actualScale);
  if (scalesEqual(actualInput, expectedScale)) return undefined;

  return {
    // Unset/identity scale is reported as the number 1 (not a scale of 1 as
    // distinct from "no scale" -- they're the same thing), matching the
    // expected side's plain-number formatting for an easy side-by-side read.
    actual: actualScale === undefined ? '1' : String(actualScale),
    expected: isNullish(expectedScale)
      ? '1'
      : JSON.stringify(expectedScale, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
  };
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
  // altVM support (below) covers Solana/Aleo/Radix/etc, but a route consisting only
  // of chains this check genuinely can't verify at all (unknown protocols, or
  // non-EVM protocols with no altVM reader, e.g. legacy Cosmos SDK chains) has
  // nothing to check -- fail fast rather than silently reporting a route as valid
  // when zero chains were actually verified.
  assert(
    knownWarpCoreTokens.some(
      (token) =>
        isEVMLike(multiProvider.getProtocol(token.chainName)) ||
        isSupportedAltVmProtocol(multiProvider.tryGetProtocol(token.chainName)),
    ),
    'Warp route check requires at least one EVM or supported altVM chain in the selected route config',
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

  // Read altVM on-chain state up front: it's needed both for the diff below and
  // to seed metadata before expandWarpDeployConfig runs (see next comment).
  const altVmOnChainDerivedConfigs = await getAltVmOnChainDerivedConfigs({
    multiProvider,
    warpCoreConfig,
  });

  // expandWarpDeployConfig derives name/symbol/decimals via deriveTokenMetadata,
  // which is EVM-only: it resolves each chain's metadata by falling back to any
  // other chain's metadata in the route, and throws (TokenMetadataMap.getSymbol)
  // if nothing resolves anywhere. A route with no EVM legs, and no chain that
  // explicitly configures name/symbol, has nothing to fall back to -- which would
  // otherwise crash `warp check` on a schema-valid altVM-only route instead of
  // returning a result. Seed real on-chain name/symbol/decimals for altVM chains
  // that don't already specify them, so there's always something to resolve.
  // Cosmos SDK chains don't store token metadata on-chain (decimals is always a
  // 0 placeholder, invalid per TokenMetadataSchema) so they're left unseeded; an
  // all-Cosmos route with no explicit metadata anywhere is a limitation of the
  // chain itself, not something this check can resolve.
  const metadataSeededWarpDeployConfig = deepCopy(warpDeployConfig);
  for (const [chain, derivedConfig] of Object.entries(
    altVmOnChainDerivedConfigs,
  )) {
    const chainConfig = metadataSeededWarpDeployConfig[chain];
    const decimals =
      'decimals' in derivedConfig ? derivedConfig.decimals : undefined;
    if (
      !chainConfig ||
      chainConfig.type === TokenType.native ||
      !('name' in derivedConfig) ||
      !('symbol' in derivedConfig) ||
      isNullish(decimals) ||
      decimals <= 0
    ) {
      continue;
    }
    if (isNullish(chainConfig.name)) chainConfig.name = derivedConfig.name;
    if (isNullish(chainConfig.symbol))
      chainConfig.symbol = derivedConfig.symbol;
    if (isNullish(chainConfig.decimals)) chainConfig.decimals = decimals;
  }

  // Native altVM tokens carry no name/symbol/decimals on-chain (DerivedNativeWarpConfig
  // has no such fields; the seeding above always skips them), so they'd hit the same
  // getSymbol crash the seeding above prevents for other types. Seed from the chain's
  // own native currency metadata instead -- the same source EVM's deriveTokenMetadata
  // uses for its (EVM-only) native branch.
  for (const chain of Object.keys(metadataSeededWarpDeployConfig)) {
    const chainConfig = metadataSeededWarpDeployConfig[chain];
    if (
      chainConfig.type !== TokenType.native ||
      !isSupportedAltVmProtocol(multiProvider.tryGetProtocol(chain))
    ) {
      continue;
    }
    const nativeToken = multiProvider.getChainMetadata(chain).nativeToken;
    if (!nativeToken) continue;
    if (isNullish(chainConfig.name)) chainConfig.name = nativeToken.name;
    if (isNullish(chainConfig.symbol)) chainConfig.symbol = nativeToken.symbol;
    if (isNullish(chainConfig.decimals))
      chainConfig.decimals = nativeToken.decimals;
  }

  const expandedWarpDeployConfig = await expandWarpDeployConfig({
    multiProvider,
    warpDeployConfig: metadataSeededWarpDeployConfig,
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

  // AltVM check: diff the already-fetched on-chain state against the expanded
  // deploy config
  const altVmOnChainConfigs: Record<string, AltVmCheckConfig> = objMap(
    altVmOnChainDerivedConfigs,
    (chain, config) =>
      derivedWarpConfigToCheckConfig(config, multiProvider.getProtocol(chain)),
  );

  const altVmExpectedConfigs: Record<string, AltVmCheckConfig> = {};
  for (const [chain, config] of Object.entries(normalizedWarpDeployConfig)) {
    if (isSupportedAltVmProtocol(multiProvider.tryGetProtocol(chain))) {
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

  for (const chain of Object.keys(altVmExpectedConfigs)) {
    const onChainConfig = altVmOnChainConfigs[chain];
    if (!onChainConfig) continue; // already reported as a missing route above

    const scaleMismatch = altVmScaleMismatch(
      onChainConfig.scale,
      normalizedWarpDeployConfig[chain]?.scale,
    );
    if (scaleMismatch) {
      addNestedDiff(rawAltVmDiff, chain, ['scale'], scaleMismatch);
    }
  }

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
          ? {
              ...currentDeployedConfig.proxyAdmin,
              address: undefined,
            }
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

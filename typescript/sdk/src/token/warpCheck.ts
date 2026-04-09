import {
  IERC4626__factory,
  IXERC20Lockbox__factory,
  Ownable__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';
import { createWarpTokenReader } from '@hyperlane-xyz/deploy-sdk';
import { hasProtocol } from '@hyperlane-xyz/provider-sdk';
import {
  type ObjectDiff,
  assert,
  deepCopy,
  diffObjMerge,
  eqAddress,
  isEVMLike,
  keepOnlyDiffObjects,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { isProxy, proxyAdmin } from '../deploy/proxy.js';
import { altVmChainLookup } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
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

export async function getWarpRouteConfigsByCore({
  multiProvider,
  warpCoreConfig,
}: {
  multiProvider: MultiProvider;
  warpCoreConfig: WarpCoreConfig;
}): Promise<DerivedWarpRouteDeployConfig> {
  const addresses = Object.fromEntries(
    warpCoreConfig.tokens.map((t) => [t.chainName, t.addressOrDenom!]),
  );

  return promiseObjAll(
    objMap(addresses, async (chain, address) => {
      const protocol = multiProvider.getProtocol(chain);

      if (isEVMLike(protocol)) {
        return new EvmWarpRouteReader(
          multiProvider,
          chain,
        ).deriveWarpRouteConfig(address);
      }

      if (!hasProtocol(protocol)) {
        throw new Error(`Unsupported protocol ${protocol} for chain ${chain}`);
      }

      const chainLookup = altVmChainLookup(multiProvider);
      const chainMetadata = chainLookup.getChainMetadata(chain);
      const reader = createWarpTokenReader(chainMetadata, chainLookup);
      return reader.deriveWarpConfig(address);
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
  const evmWarpCoreConfig = {
    ...warpCoreConfig,
    tokens: warpCoreConfig.tokens.filter((token) =>
      isEVMLike(multiProvider.getProtocol(token.chainName)),
    ),
  };

  const evmWarpDeployConfig = objFilter(
    warpDeployConfig,
    (chain, _config): _config is WarpRouteDeployConfigMailboxRequired[string] =>
      isEVMLike(multiProvider.getProtocol(chain)),
  );

  const deployedRoutersAddresses =
    getRouterAddressesFromWarpCoreConfig(evmWarpCoreConfig);
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
    warpDeployConfig: evmWarpDeployConfig,
    deployedRoutersAddresses,
    expandedOnChainWarpConfig,
  });

  const rawDiff = buildWarpRouteDiff({
    onChainWarpConfig: expandedOnChainWarpConfig,
    warpRouteConfig: expandedWarpDeployConfig,
  });

  await addOwnerOverrideDiffs({
    multiProvider,
    diff: rawDiff,
    warpRouteConfig: expandedWarpDeployConfig,
  });

  const diff = keepOnlyDiffObjects(rawDiff) as Record<string, ObjectDiff>;
  const diffViolations = flattenWarpRouteCheckDiff(diff);
  const scaleViolations = getScaleViolations(expandedWarpDeployConfig);

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
    {} as Record<string, ObjectDiff>,
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
      const collateralToken = await getCollateralOwnable(config, provider);
      if (
        collateralToken &&
        (await isProxy(provider, collateralToken.address))
      ) {
        const collateralProxyAdminAddress = await proxyAdmin(
          provider,
          collateralToken.address,
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

async function getCollateralOwnable(
  config: WarpRouteDeployConfigMailboxRequired[string],
  provider: ReturnType<MultiProvider['getProvider']>,
) {
  if (isXERC20TokenConfig(config)) {
    if (config.type === TokenType.XERC20Lockbox) {
      const xerc20Address = await IXERC20Lockbox__factory.connect(
        config.token,
        provider,
      ).callStatic['XERC20()']();
      return Ownable__factory.connect(xerc20Address, provider);
    }

    return Ownable__factory.connect(config.token, provider);
  }

  if (isCollateralTokenConfig(config) || isCrossCollateralTokenConfig(config)) {
    if (
      config.type === TokenType.collateralVault ||
      config.type === TokenType.collateralVaultRebase
    ) {
      const collateralTokenAddress = await IERC4626__factory.connect(
        config.token,
        provider,
      ).asset();
      return Ownable__factory.connect(collateralTokenAddress, provider);
    }

    return Ownable__factory.connect(config.token, provider);
  }

  return undefined;
}

function addNestedDiff(
  diff: Record<string, ObjectDiff>,
  chain: string,
  path: string[],
  value: ObjectDiffLeaf,
) {
  if (!isObjectDiffMap(diff[chain])) {
    diff[chain] = {};
  }

  let cursor = diff[chain];
  assert(isObjectDiffMap(cursor), `Failed to initialize diff for ${chain}`);

  for (const key of path.slice(0, -1)) {
    if (!isObjectDiffMap(cursor[key])) {
      cursor[key] = {};
    }

    const nextCursor = cursor[key];
    assert(
      isObjectDiffMap(nextCursor),
      `Failed to initialize nested diff for ${chain}.${key}`,
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

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      flattenDiffNode(chain, item, [...path, index.toString()]),
    );
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) => flattenDiffNode(chain, child, [...path, key]),
    );
  }

  return [];
}

function getScaleViolations(
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>,
): WarpRouteCheckViolation[] {
  if (verifyScale(warpRouteConfig)) {
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

import { stringify as yamlStringify } from 'yaml';

import {
  type AccountConfig,
  type DerivedWarpRouteDeployConfig,
  EvmWarpRouteReader,
  type HypTokenRouterVirtualConfig,
  InterchainAccount,
  type TokenMetadata,
  type WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
  resolveRouterMapConfig,
  transformConfigToCheck,
  verifyScale,
} from '@hyperlane-xyz/sdk';
import {
  type ObjectDiff,
  assert,
  bytes32ToAddress,
  diffObjMerge,
  eqAddress,
  isAddressEvm,
  isEVMLike,
  keepOnlyDiffObjects,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { log, logGreen, logRed, warnYellow } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

const CROSS_COLLATERAL_TYPE = 'crossCollateral';

type CrossCollateralConfigWithRouters = {
  type: string;
  crossCollateralRouters?: Record<string, string[]>;
};

export async function runWarpRouteCheck({
  multiProvider,
  warpRouteConfig,
  onChainWarpConfig,
}: {
  multiProvider: CommandContext['multiProvider'];
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
  onChainWarpConfig: DerivedWarpRouteDeployConfig &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
}): Promise<void> {
  // Check whether the decimals are consistent. If not, ensure that the scale is correct.
  const decimalsAreValid = await verifyDecimalsAndScale({
    multiProvider,
    warpRouteConfig,
  });

  // Go through each chain and only add to the output the chains that have mismatches
  const [violations, isInvalid] = Object.keys(warpRouteConfig).reduce(
    (acc, chain) => {
      const expectedDeployedConfig = warpRouteConfig[chain];
      const currentDeployedConfig = onChainWarpConfig[chain];

      // If the expected config specifies the hook or the ism as an address instead of the full config
      // compare just the addresses
      if (typeof expectedDeployedConfig.hook === 'string') {
        currentDeployedConfig.hook = derivedHookAddress(currentDeployedConfig);
      }

      if (typeof expectedDeployedConfig.interchainSecurityModule === 'string') {
        currentDeployedConfig.interchainSecurityModule = derivedIsmAddress(
          currentDeployedConfig,
        );
      }

      // if the input config does not specify the expected contractVersion we skip to
      // avoid triggering a false positive
      if (!expectedDeployedConfig.contractVersion) {
        currentDeployedConfig.contractVersion = undefined;
      }

      const { mergedObject, isInvalid } = diffObjMerge(
        transformConfigToCheck(currentDeployedConfig),
        transformConfigToCheck(expectedDeployedConfig),
      );

      if (isInvalid) {
        acc[0][chain] = mergedObject;
        acc[1] ||= isInvalid;
      }

      return acc;
    },
    [{}, false] as [{ [index: string]: ObjectDiff }, boolean],
  );

  if (isInvalid) {
    log(
      formatYamlViolationsOutput(
        yamlStringify(keepOnlyDiffObjects(violations), null, 2),
      ),
    );
    process.exit(1);
  }

  if (!decimalsAreValid) {
    process.exit(1);
  }
  logGreen(`No violations found`);
}

async function buildScaleValidationMetadataMap({
  multiProvider,
  warpRouteConfig,
}: {
  multiProvider: CommandContext['multiProvider'];
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
}): Promise<Map<string, TokenMetadata>> {
  const metadataByKey = new Map<string, TokenMetadata>(
    Object.entries(warpRouteConfig).map(([chain, config]) => [
      chain,
      {
        name: config.name ?? 'unknown',
        symbol: config.symbol ?? 'unknown',
        decimals: config.decimals,
        scale: config.scale,
      },
    ]),
  );
  const readerByChain = new Map<string, EvmWarpRouteReader>();
  const routerMetadataPromises = new Map<string, Promise<TokenMetadata>>();

  for (const [, config] of Object.entries(warpRouteConfig)) {
    const crossCollateralConfig = config as CrossCollateralConfigWithRouters;
    if (
      crossCollateralConfig.type !== CROSS_COLLATERAL_TYPE ||
      !crossCollateralConfig.crossCollateralRouters
    ) {
      continue;
    }

    const crossCollateralRouters = resolveRouterMapConfig(
      multiProvider,
      crossCollateralConfig.crossCollateralRouters,
    );

    for (const [domain, routers] of Object.entries(crossCollateralRouters)) {
      const chain = multiProvider.getChainName(Number(domain));

      for (const routerId of routers as string[]) {
        const routerAddress = normalizeAddressEvm(
          isAddressEvm(routerId) ? routerId : bytes32ToAddress(routerId),
        );
        const metadataKey = `${chain}:${routerAddress.toLowerCase()}`;

        if (routerMetadataPromises.has(metadataKey)) {
          continue;
        }

        const reader =
          readerByChain.get(chain) ??
          new EvmWarpRouteReader(multiProvider, chain);
        readerByChain.set(chain, reader);
        routerMetadataPromises.set(
          metadataKey,
          (async () => {
            try {
              const routerConfig =
                await reader.deriveWarpRouteConfig(routerAddress);
              return {
                name: routerConfig.name ?? 'unknown',
                symbol: routerConfig.symbol ?? 'unknown',
                decimals: routerConfig.decimals,
                scale: routerConfig.scale,
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `Failed to derive configured crossCollateral router ${routerId} on ${chain}: ${message}`,
              );
            }
          })(),
        );
      }
    }
  }

  for (const [
    metadataKey,
    metadataPromise,
  ] of routerMetadataPromises.entries()) {
    metadataByKey.set(metadataKey, await metadataPromise);
  }

  return metadataByKey;
}

export async function verifyDecimalsAndScale({
  multiProvider,
  warpRouteConfig,
}: {
  multiProvider: CommandContext['multiProvider'];
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
}): Promise<boolean> {
  let valid = true;
  const scaleValidationMetadata = await buildScaleValidationMetadataMap({
    multiProvider,
    warpRouteConfig,
  });

  if (!verifyScale(scaleValidationMetadata)) {
    logRed(
      `Found inconsistent decimals/scale across route and configured crossCollateralRouters`,
    );
    valid = false;
  }
  return valid;
}

/**
 * Checks that destination chain owners match expected ICA addresses
 * derived from the origin chain owner.
 */
export async function runWarpIcaOwnerCheck({
  context,
  warpDeployConfig,
  origin,
  originOwner: originOwnerOverride,
  chains,
}: {
  context: CommandContext;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  origin: string;
  originOwner?: string;
  chains?: string[];
}): Promise<void> {
  const { registry, multiProvider } = context;
  const configChains = new Set(Object.keys(warpDeployConfig));
  const originOwner = originOwnerOverride ?? warpDeployConfig[origin]?.owner;
  assert(
    originOwner,
    `Origin chain "${origin}" does not have an owner configured and --originOwner was not provided`,
  );

  // Filter chains: must be in config, EVM, and not the origin chain
  const chainsToCheck = (chains ?? [...configChains]).filter((chain) => {
    if (chain === origin) {
      return false;
    }
    if (!configChains.has(chain)) {
      warnYellow(`Chain "${chain}" is not part of the warp config, skipping`);
      return false;
    }
    if (!isEVMLike(multiProvider.tryGetProtocol(chain)!)) {
      warnYellow(`Skipping non-EVM destination chain "${chain}"`);
      return false;
    }
    return true;
  });
  assert(chainsToCheck.length > 0, 'No EVM destination chains to check');
  assert(
    isEVMLike(multiProvider.tryGetProtocol(origin)!),
    `origin ${origin} must be EVM chain`,
  );

  // Get ICA router addresses from registry
  const chainAddresses: Record<string, Record<string, string>> = {};
  for (const chain of [origin, ...chainsToCheck]) {
    const addresses = await registry.getChainAddresses(chain);
    assert(
      addresses?.interchainAccountRouter,
      `No interchainAccountRouter found for chain ${chain}`,
    );
    chainAddresses[chain] = addresses;
  }

  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);
  const ownerConfig: AccountConfig = {
    origin,
    owner: originOwner,
    // TODO: Support ISM override in the future. For now, use default ISM.
  };

  // Check each destination chain
  const violations: Record<string, ObjectDiff> = {};

  for (const destination of chainsToCheck) {
    const configuredOwner = warpDeployConfig[destination].owner;
    const expectedIcaAddress = await ica.getAccount(destination, ownerConfig);

    if (!eqAddress(configuredOwner, expectedIcaAddress)) {
      violations[destination] = {
        owner: {
          actual: normalizeAddressEvm(configuredOwner),
          expected: normalizeAddressEvm(expectedIcaAddress),
        },
      };
    }
  }

  if (Object.keys(violations).length > 0) {
    log(
      formatYamlViolationsOutput(
        yamlStringify(keepOnlyDiffObjects(violations), null, 2),
      ),
    );
    process.exit(1);
  }

  logGreen('No violations found');
}

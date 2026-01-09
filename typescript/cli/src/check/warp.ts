import { stringify as yamlStringify } from 'yaml';

import {
  type AccountConfig,
  type DerivedWarpRouteDeployConfig,
  type HypTokenRouterVirtualConfig,
  InterchainAccount,
  type WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
  transformConfigToCheck,
  verifyScale,
} from '@hyperlane-xyz/sdk';
import {
  type ObjectDiff,
  ProtocolType,
  assert,
  diffObjMerge,
  eqAddress,
  keepOnlyDiffObjects,
} from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { log, logGreen, logRed, warnYellow } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export async function runWarpRouteCheck({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
  onChainWarpConfig: DerivedWarpRouteDeployConfig &
    Record<string, Partial<HypTokenRouterVirtualConfig>>;
}): Promise<void> {
  // Check whether the decimals are consistent. If not, ensure that the scale is correct.
  const decimalsAreValid = verifyDecimalsAndScale(warpRouteConfig);

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

function verifyDecimalsAndScale(
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>,
): boolean {
  let valid = true;
  if (!verifyScale(warpRouteConfig)) {
    logRed(`Found invalid or missing scale for inconsistent decimals`);
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
  destinations,
}: {
  context: CommandContext;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  origin?: string;
  destinations?: string[];
}): Promise<void> {
  const { registry, multiProvider } = context;
  const configChains = new Set(Object.keys(warpDeployConfig));

  assert(origin, '--origin is required when using --ica');
  assert(
    configChains.has(origin),
    `Origin chain "${origin}" is not part of the warp config`,
  );

  const originOwner = warpDeployConfig[origin].owner;
  assert(
    originOwner,
    `Origin chain "${origin}" does not have an owner configured`,
  );

  // Filter destinations: must be in config, EVM, and not origin
  const chainsToCheck = (destinations ?? [...configChains]).filter((chain) => {
    if (!configChains.has(chain)) {
      warnYellow(`Chain "${chain}" is not part of the warp config, skipping`);
      return false;
    }
    if (chain === origin) return false;
    if (multiProvider.tryGetProtocol(chain) !== ProtocolType.Ethereum) {
      warnYellow(`Skipping non-EVM chain "${chain}"`);
      return false;
    }
    return true;
  });

  assert(chainsToCheck.length > 0, 'No EVM destination chains to check');

  // Get ICA router addresses from registry
  const chainAddresses: Record<string, Record<string, string>> = {};
  for (const chain of [origin, ...chainsToCheck]) {
    const addresses = await registry.getChainAddresses(chain);
    assert(
      addresses?.interchainAccountRouter,
      `No interchainAccountRouter found for chain ${chain}`,
    );
    chainAddresses[chain] = addresses as Record<string, string>;
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
          actual: configuredOwner.toLowerCase(),
          expected: expectedIcaAddress.toLowerCase(),
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

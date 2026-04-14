import { stringify as yamlStringify } from 'yaml';

import {
  type AccountConfig,
  InterchainAccount,
  type WarpRouteCheckResult,
  type WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import {
  type ObjectDiff,
  assert,
  eqAddress,
  isEVMLike,
  keepOnlyDiffObjects,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { log, logGreen, logRed, warnYellow } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export async function runWarpRouteCheck({
  result,
}: {
  result: WarpRouteCheckResult;
}): Promise<void> {
  if (Object.keys(result.diff).length > 0) {
    log(formatYamlViolationsOutput(yamlStringify(result.diff, null, 2)));
  }

  if (result.scaleViolations.length > 0) {
    logRed(`Found invalid or missing scale for inconsistent decimals`);
  }

  if (!result.isValid) {
    process.exit(1);
  }

  logGreen(`No violations found`);
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

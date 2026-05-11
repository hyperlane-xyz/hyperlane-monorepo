import { stringify as yamlStringify } from 'yaml';

import {
  type AccountConfig,
  InterchainAccount,
  type WarpCoreConfig,
  type WarpRouteCheckResult,
  type WarpRouteDeployConfigMailboxRequired,
  checkWarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  type ObjectDiff,
  assert,
  eqAddress,
  isEVMLike,
  keepOnlyDiffObjects,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
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

/**
 * Checks a combined CROSS warp route by finding its constituent routes (those whose
 * tokens are a subset of the CROSS config's tokens) and checking each one separately.
 * Used when a CROSS route has no deploy config of its own.
 */
export async function checkCrossCollateralWarpRoute({
  context,
  warpCoreConfig,
  warpRouteId,
}: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
  warpRouteId: string;
}): Promise<WarpRouteCheckResult> {
  const crossAddresses = new Set(
    warpCoreConfig.tokens
      .filter((t) => t.addressOrDenom)
      .map((t) => t.addressOrDenom!.toLowerCase()),
  );

  const allRoutes = await context.registry.getWarpRoutes();
  const constituentRouteIds: string[] = [];

  for (const [routeId, routeCoreConfig] of Object.entries(allRoutes)) {
    if (routeId === warpRouteId) continue;
    if (routeCoreConfig.tokens.length === 0) continue;

    if (
      routeCoreConfig.tokens.every(
        (t) =>
          t.addressOrDenom &&
          crossAddresses.has(t.addressOrDenom.toLowerCase()),
      )
    ) {
      constituentRouteIds.push(routeId);
    }
  }

  assert(
    constituentRouteIds.length > 0,
    `No deploy config found for "${warpRouteId}" and no constituent routes could be identified. ` +
      `Ensure constituent routes have deploy configs in the registry.`,
  );

  const combinedResult: WarpRouteCheckResult = {
    isValid: true,
    violations: [],
    diff: {},
    scaleViolations: [],
  };

  for (const constituentId of constituentRouteIds) {
    const constituentCoreConfig = allRoutes[constituentId];
    const constituentDeployConfig = await readWarpRouteDeployConfig({
      context,
      warpRouteId: constituentId,
    });

    const result = await checkWarpRouteDeployConfig({
      multiProvider: context.multiProvider,
      warpCoreConfig: constituentCoreConfig,
      warpDeployConfig: constituentDeployConfig,
    });

    combinedResult.isValid = combinedResult.isValid && result.isValid;
    combinedResult.violations.push(...result.violations);
    combinedResult.scaleViolations.push(...result.scaleViolations);

    for (const [chain, diff] of Object.entries(result.diff)) {
      combinedResult.diff[`${constituentId}/${chain}`] = diff;
    }
  }

  return combinedResult;
}

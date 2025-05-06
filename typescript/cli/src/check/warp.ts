import { stringify as yamlStringify } from 'yaml';

import {
  DerivedWarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
  transformConfigToCheck,
} from '@hyperlane-xyz/sdk';
import { ObjectDiff, diffObjMerge } from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export async function runWarpRouteCheck({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired;
  onChainWarpConfig: DerivedWarpRouteDeployConfig;
}): Promise<void> {
  // Go through each chain and only add to the output the chains that have mismatches
  const [violations, isInvalid] = Object.keys(warpRouteConfig).reduce(
    (acc, chain) => {
      const expectedDeployedConfig = warpRouteConfig[chain];
      const currentDeployedConfig = onChainWarpConfig[chain];

      // If the expected config specifies the hook as an address instead of the full config
      // compare just the addresses
      if (
        expectedDeployedConfig.hook &&
        typeof expectedDeployedConfig.hook === 'string'
      ) {
        currentDeployedConfig.hook = derivedHookAddress(currentDeployedConfig);
      }

      if (
        expectedDeployedConfig.interchainSecurityModule &&
        typeof expectedDeployedConfig.interchainSecurityModule === 'string'
      ) {
        currentDeployedConfig.interchainSecurityModule = derivedIsmAddress(
          currentDeployedConfig,
        );
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
    log(formatYamlViolationsOutput(yamlStringify(violations, null, 2)));
    process.exit(1);
  }

  logGreen(`No violations found`);
}

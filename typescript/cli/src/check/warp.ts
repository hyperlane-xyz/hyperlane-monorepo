import { stringify as yamlStringify } from 'yaml';

import {
  DerivedWarpRouteDeployConfig,
  HypTokenRouterVirtualConfig,
  WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
  transformConfigToCheck,
} from '@hyperlane-xyz/sdk';
import {
  ObjectDiff,
  diffObjMerge,
  keepOnlyDiffObjects,
} from '@hyperlane-xyz/utils';

import { log, logGreen, logRed } from '../logger.js';
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
  Object.values(warpRouteConfig).forEach((config) => {
    if (config.decimals === undefined && config.decimals !== 0) {
      logRed('Decimals, if defined, must not be zero');
      process.exit(1);
    }
  });

  if (!areDecimalsUniform(warpRouteConfig)) {
    const maxDecimals = Math.max(
      ...Object.values(warpRouteConfig).map((config) => config.decimals!),
    );

    for (const [chain, config] of Object.entries(warpRouteConfig)) {
      if (config.decimals) {
        const scale = 10 ** (maxDecimals - config.decimals);
        if (!config.scale && scale !== 1) {
          logRed(`Scale is required for ${chain}`);
          process.exit(1);
        } else if (config.scale && scale !== config.scale) {
          logRed(`Scale is not correct for ${chain}`);
          process.exit(1);
        }
      }
    }
  }

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

  logGreen(`No violations found`);
}

function areDecimalsUniform(configMap: Record<string, any>): boolean {
  const values = [...Object.values(configMap)];
  const [first, ...rest] = values;
  for (const d of rest) {
    if (d.decimals !== first.decimals) {
      return false;
    }
  }
  return true;
}

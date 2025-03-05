import { stringify as yamlStringify } from 'yaml';

import {
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ChainId,
  ObjectDiff,
  diffObjMerge,
} from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

type HypTokenRouterConfigToCheck = Omit<
  HypTokenRouterConfig,
  'remoteRouters'
> & {
  remoteRouters: Record<ChainId, { routerAddress: Address }>;
};

// Changes address fields occurrences that should be checked in the config to have a
// different name as the normalizeConfig function removes all the address
// fields from a given object
function formatTokenConfigToCheck(
  config: HypTokenRouterConfig,
): HypTokenRouterConfigToCheck {
  const formattedConfig: any = {};
  for (const [key, value] of Object.entries(config)) {
    if ((key as keyof HypTokenRouterConfig) !== 'remoteRouters') {
      formattedConfig[key as keyof HypTokenRouterConfig] = value;
    }
  }

  if (config.remoteRouters) {
    formattedConfig.remoteRouters = Object.entries(config.remoteRouters).reduce(
      (acc, [chain, config]) => {
        acc[chain] = {
          routerAddress: config.address,
        };

        return acc;
      },
      {} as HypTokenRouterConfigToCheck['remoteRouters'],
    );
  }

  return formattedConfig;
}

export async function runWarpRouteCheck({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: WarpRouteDeployConfig;
  onChainWarpConfig: WarpRouteDeployConfig;
}): Promise<void> {
  // Go through each chain and only add to the output the chains that have mismatches
  const [violations, isInvalid] = Object.keys(warpRouteConfig).reduce(
    (acc, chain) => {
      const { mergedObject, isInvalid } = diffObjMerge(
        normalizeConfig(formatTokenConfigToCheck(onChainWarpConfig[chain])),
        normalizeConfig(formatTokenConfigToCheck(warpRouteConfig[chain])),
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

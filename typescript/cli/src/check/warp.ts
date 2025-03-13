import { stringify as yamlStringify } from 'yaml';

import {
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
  sortArraysInConfig,
  transformWarpDeployConfigToCheck,
} from '@hyperlane-xyz/sdk';
import { ObjectDiff, diffObjMerge, transformObj } from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export function formatConfigToCheck(
  obj: HypTokenRouterConfig,
): HypTokenRouterConfig {
  return sortArraysInConfig(
    transformObj(obj, transformWarpDeployConfigToCheck),
  );
}

const KEYS_TO_IGNORE = ['totalSupply'];

function sanitizeConfig(obj: any): any {
  // Remove keys from obj
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !KEYS_TO_IGNORE.includes(key)),
  );
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
        sanitizeConfig(formatConfigToCheck(onChainWarpConfig[chain])),
        sanitizeConfig(formatConfigToCheck(warpRouteConfig[chain])),
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

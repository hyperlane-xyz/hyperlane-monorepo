import { stringify as yamlStringify } from 'yaml';

import {
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
  sortArraysInConfig,
} from '@hyperlane-xyz/sdk';
import {
  FormatObjectFormatter,
  ObjectDiff,
  diffObjMerge,
  formatObj,
} from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

const formatter: FormatObjectFormatter = (
  obj: any,
  propPath: ReadonlyArray<string>,
) => {
  // Needed to check if we are currently inside the remoteRouters object
  const key = propPath[propPath.length - 3];
  const parentKey = propPath[propPath.length - 1];

  // Remove the address and ownerOverrides fields if we are not inside the
  // remoteRouters property
  if (
    (parentKey === 'address' && key !== 'remoteRouters') ||
    parentKey === 'ownerOverrides'
  ) {
    return {
      formattedValue: obj,
      shouldInclude: false,
    };
  }

  if (typeof obj === 'string') {
    return {
      formattedValue: obj.toLowerCase(),
      shouldInclude: true,
    };
  }

  return {
    formattedValue: obj,
    shouldInclude: true,
  };
};

export function formatConfigToCheck(
  obj: HypTokenRouterConfig,
): HypTokenRouterConfig {
  return sortArraysInConfig(formatObj(obj, formatter));
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
        formatConfigToCheck(onChainWarpConfig[chain]),
        formatConfigToCheck(warpRouteConfig[chain]),
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

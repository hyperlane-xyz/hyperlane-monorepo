import { stringify as yamlStringify } from 'yaml';

import {
  WarpRouteDeployConfigMailboxRequired,
  WarpTokenRouterVirtualConfig,
  transformConfigToCheck,
} from '@hyperlane-xyz/sdk';
import { ObjectDiff, diffObjMerge } from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export async function runWarpRouteCheck({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    WarpTokenRouterVirtualConfig;
  onChainWarpConfig: WarpRouteDeployConfigMailboxRequired;
}): Promise<void> {
  // Go through each chain and only add to the output the chains that have mismatches
  const [violations, isInvalid] = Object.keys(warpRouteConfig).reduce(
    (acc, chain) => {
      const { mergedObject, isInvalid } = diffObjMerge(
        transformConfigToCheck(onChainWarpConfig[chain]),
        transformConfigToCheck(warpRouteConfig[chain]),
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

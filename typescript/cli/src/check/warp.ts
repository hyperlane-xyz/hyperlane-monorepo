import { constants } from 'ethers';
import { stringify as yamlStringify } from 'yaml';

import {
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import { ObjectDiff, diffObjMerge } from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export async function runWarpRouteCheck({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: Readonly<WarpRouteDeployConfig>;
  onChainWarpConfig: WarpRouteDeployConfig;
}): Promise<void> {
  // Go through each chain and only add to the output the chains that have mismatches
  const [violations, isInvalid] = Object.keys(warpRouteConfig).reduce(
    (acc, chain) => {
      formatCheckerInput({
        warpRouteConfig: warpRouteConfig[chain],
        onChainWarpConfig: onChainWarpConfig[chain],
      });

      const { mergedObject, isInvalid } = diffObjMerge(
        normalizeConfig(onChainWarpConfig[chain]),
        normalizeConfig(warpRouteConfig[chain]),
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

function formatCheckerInput({
  warpRouteConfig,
  onChainWarpConfig,
}: {
  warpRouteConfig: Readonly<HypTokenRouterConfig>;
  onChainWarpConfig: HypTokenRouterConfig;
}) {
  // If the hook config is not defined in the input file,
  // we need to remove it from the onChainWarpConfig if it was derived
  if (!warpRouteConfig.hook) {
    onChainWarpConfig.hook = undefined;
  }

  // if the hook config is defined the input file, it means the user wants to check
  // the hook config, so we need to add the default hook address to the onChainWarpConfig
  // in case the default hook is currently used by the token.
  if (warpRouteConfig.hook && !onChainWarpConfig.hook) {
    onChainWarpConfig.hook = constants.AddressZero;
  }

  // If the ism config is not defined in the input file,
  // we need to remove it from the onChainWarpConfig if it was derived
  if (!warpRouteConfig.interchainSecurityModule) {
    onChainWarpConfig.interchainSecurityModule = undefined;
  }

  if (
    warpRouteConfig.interchainSecurityModule &&
    !onChainWarpConfig.interchainSecurityModule
  ) {
    // Same as with the hook, if the interchainSecurityModule is defined in the input file,
    // if the user defined it, we need to add the default address to the onChainWarpConfig
    // in case the default interchainSecurityModule is currently used by the token.
    onChainWarpConfig.interchainSecurityModule = constants.AddressZero;
  }
}

import { stringify as yamlStringify } from 'yaml';

import {
  DerivedWarpRouteDeployConfig,
  HypTokenRouterVirtualConfig,
  WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
  transformConfigToCheck,
  verifyScale,
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
  // Check whether the decimals are consistent. If not, ensure that the scale is correct.
  verifyDecimalsAndScale(warpRouteConfig);

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

function verifyDecimalsAndScale(
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
    Record<string, Partial<HypTokenRouterVirtualConfig>>,
) {
  Object.values(warpRouteConfig).forEach((config) => {
    if (config.decimals === undefined && config.decimals !== 0) {
      logRed('Decimals, if defined, must not be zero');
      process.exit(1);
    }
  });

  if (!verifyScale(warpRouteConfig)) {
    logRed(`Found invalid or missing scale for inconsistent decimals`);
    process.exit(1);
  }
}

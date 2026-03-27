import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import {
  objMap,
  sortNestedArrays,
  ArraySortConfig,
} from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../config/warp.js';
import { getArgs, withWarpRouteIds } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

const WARP_YAML_SORT_CONFIG: ArraySortConfig = {
  arrays: [
    { path: 'tokens', sortKey: 'chainName' },
    { path: 'tokens[].connections', sortKey: 'token' },
    { path: '*.interchainSecurityModule.modules', sortKey: 'type' },
    {
      path: '*.interchainSecurityModule.modules[].domains.*.modules',
      sortKey: 'type',
    },
  ],
};

function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce(
        (sorted, key) => {
          sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
          return sorted;
        },
        {} as Record<string, unknown>,
      );
  }
  return obj;
}

// Writes the warp configs into the Registry
async function main() {
  const { environment, warpRouteIds } = await withWarpRouteIds(getArgs()).argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);
  const registry = getRegistry();

  const warpIdsToCheck =
    !warpRouteIds || warpRouteIds.length === 0
      ? Object.keys(warpConfigGetterMap)
      : warpRouteIds;

  for (const warpRouteId of warpIdsToCheck) {
    console.log(`Generating Warp config for ${warpRouteId}`);

    const warpConfig = await getWarpConfig(
      multiProvider,
      envConfig,
      warpRouteId,
    );

    const registryConfig: WarpRouteDeployConfig = objMap(
      warpConfig,
      (_, config) => {
        const { mailbox: _mailbox, ...rest } = config;
        return rest;
      },
    );

    console.log(`Sorting Warp config for ${warpRouteId}`);
    const sorted = sortObjectKeys(
      sortNestedArrays(registryConfig, WARP_YAML_SORT_CONFIG),
    );
    const configString = yamlStringify(sorted, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    registry.addWarpRouteConfig(yamlParse(configString), {
      warpRouteId,
    });

    console.log(
      `Warp config successfully created at ${registry.getUri()}/deployments/warp_routes/${warpRouteId}-deploy.yaml`,
    );
  }
}

main().catch((err) => console.error('Error:', err));

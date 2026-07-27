import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import {
  normalizeConfig,
  objMap,
  rootLogger,
  sortNestedArrays,
  sortObjectKeys,
  WARP_YAML_SORT_CONFIG,
} from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../config/warp.js';
import { getArgs, withWarpRouteIds } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

const logger = rootLogger.child({ module: 'check-warp-registry-drift' });

// Compares each getter-owned warp route against the registry the current
// REGISTRY_URI points at. Where the registry deploy config is stale, the
// getter output (source of truth) is written back into the registry so that a
// downstream step can open a PR. Returns the list of drifted route ids.
async function main(): Promise<void> {
  const { environment, warpRouteIds } = await withWarpRouteIds(getArgs()).argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);
  const registry = getRegistry();

  const warpIdsToCheck =
    !warpRouteIds || warpRouteIds.length === 0
      ? Object.keys(warpConfigGetterMap)
      : warpRouteIds;

  const drifted: string[] = [];
  const errored: string[] = [];

  for (const warpRouteId of warpIdsToCheck) {
    logger.info({ warpRouteId }, 'Checking warp config against registry');

    let expected: WarpRouteDeployConfig;
    try {
      const warpConfig = await getWarpConfig(
        multiProvider,
        envConfig,
        warpRouteId,
      );
      expected = objMap(warpConfig, (_, config) => {
        const { mailbox: _mailbox, ...rest } = config;
        return rest;
      });
    } catch (error) {
      logger.error({ warpRouteId, error }, 'Failed to derive getter config');
      errored.push(warpRouteId);
      continue;
    }

    const sorted = sortObjectKeys(
      sortNestedArrays(expected, WARP_YAML_SORT_CONFIG),
    );
    const configString = yamlStringify(sorted, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    const expectedConfig: WarpRouteDeployConfig = yamlParse(configString);

    const actualConfig = await registry.getWarpDeployConfig(warpRouteId);

    // mailbox is a derived addressing field, not deploy intent; the canonical
    // registry form omits it. Compare with it stripped from both sides so only
    // genuine config drift (owners, bridges, fees, ...) triggers a re-export.
    if (
      actualConfig &&
      deepEquals(
        sortObjectKeys(normalizeConfig(stripMailbox(expectedConfig))),
        sortObjectKeys(normalizeConfig(stripMailbox(actualConfig))),
      )
    ) {
      logger.info({ warpRouteId }, 'Registry is in sync with getter');
      continue;
    }

    logger.warn(
      { warpRouteId, missing: !actualConfig },
      'Registry drift detected; writing getter config',
    );
    drifted.push(warpRouteId);
    registry.addWarpRouteConfig(expectedConfig, { warpRouteId });
  }

  logger.info(
    {
      checked: warpIdsToCheck.length,
      drifted,
      errored,
    },
    'Warp registry drift check complete',
  );

  if (errored.length > 0) {
    logger.error({ errored }, 'Some getters failed to derive; investigate');
    process.exitCode = 1;
  }

  if (drifted.length > 0) {
    console.log(`DRIFTED_WARP_ROUTES=${drifted.join(',')}`);
  } else {
    console.log('DRIFTED_WARP_ROUTES=');
  }
}

function stripMailbox(config: WarpRouteDeployConfig): WarpRouteDeployConfig {
  return objMap(config, (_, chainConfig) => {
    const { mailbox: _mailbox, ...rest } = chainConfig;
    return rest;
  });
}

function deepEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

main().catch((err) => {
  logger.error({ err }, 'check-warp-registry-drift failed');
  process.exit(1);
});

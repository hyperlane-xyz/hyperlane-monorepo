import chalk from 'chalk';
import { ESLint } from 'eslint';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../config/warp.js';
import { getArgs, withWarpRouteId } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

// Writes the warp configs into the Registry
async function main() {
  const { environment, warpRouteId } = await withWarpRouteId(getArgs()).argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);
  const registry = getRegistry();

  const warpIdsToCheck = warpRouteId
    ? [warpRouteId]
    : Object.keys(warpConfigGetterMap);
  const eslint = new ESLint({
    fix: true,
    overrideConfigFile:
      '/Users/leyu/Desktop/Code/hyperlane/hyperlane-registry/eslint.config.js',
  });

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

    console.log(`Linting Warp config for ${warpRouteId}`);
    // Convert the object to a YAML string for linting
    const configString = yamlStringify(registryConfig);
    const results = await eslint.lintText(configString, {
      // The `filePath` is required for ESLint to work with in-memory text
      // This filepath does not need to exist. It simply matches one of the filepaths pattern in the eslint config
      filePath: `chains/${warpRouteId}-nonexistent-file.yaml`,
    });

    try {
      registry.addWarpRouteConfig(yamlParse(results[0].output!), {
        warpRouteId,
      });
    } catch (error) {
      console.error(
        chalk.red(`Failed to add warp route config for ${warpRouteId}:`, error),
      );
    }

    // TODO: Use registry.getWarpRoutesPath() to dynamically generate path by removing "protected"
    console.log(
      `Warp config successfully created at ${registry.getUri()}/deployments/warp_routes/${warpRouteId}-deploy.yaml`,
    );
  }
}

main().catch((err) => console.error('Error:', err));

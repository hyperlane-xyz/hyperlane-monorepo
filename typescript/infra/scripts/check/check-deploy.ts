import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { assert } from '@hyperlane-xyz/utils';

import { DEFAULT_REGISTRY_URI } from '../../config/registry.js';
import { useLocalProvider } from '../../src/utils/fork.js';
import { Modules } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';
import {
  getCheckDeployArgs,
  getGovernor,
  logViolations,
} from './check-utils.js';
import {
  logWarpRouteCheckResult,
  runWarpRouteCheckFromRegistry,
} from './check-warp-route.js';

async function main() {
  const {
    module,
    context,
    environment,
    asDeployer,
    chains,
    fork,
    govern,
    warpRouteId,
    registry,
    forceRegistryConfig,
  } = await getCheckDeployArgs().argv;

  if (module === Modules.WARP && !govern) {
    assert(warpRouteId, '--warpRouteId is required when checking WARP');

    const registries = registry?.length ? registry : [DEFAULT_REGISTRY_URI];
    const mergedRegistry = getRegistry({
      registryUris: registries,
      enableProxy: true,
    });
    const warpCoreConfig = await mergedRegistry.getWarpRoute(warpRouteId);
    assert(warpCoreConfig, `Warp route config not found for ${warpRouteId}`);

    const envConfig = getEnvironmentConfig(environment);
    const chainsToCheck =
      (chains?.length ?? 0) > 0
        ? chains
        : fork
          ? [fork]
          : warpCoreConfig.tokens.map((token) => token.chainName);
    const multiProvider = await envConfig.getMultiProvider(
      undefined,
      undefined,
      undefined,
      chainsToCheck,
    );

    if (fork) {
      await useLocalProvider(multiProvider, fork);
    }

    const result = await runWarpRouteCheckFromRegistry({
      chains: chainsToCheck,
      multiProvider,
      registryUris: registries,
      warpCoreConfig,
      warpRouteId,
    });

    if (result.violations.length > 0) {
      logWarpRouteCheckResult(result);
      throw new Error(
        `Checking ${module} deploy yielded ${result.violations.length} violations`,
      );
    }

    console.info(`${module} checker found no violations`);
    process.exit(0);
  }

  const governor = await getGovernor(
    module,
    context,
    environment,
    asDeployer,
    warpRouteId,
    chains,
    fork,
    govern,
    undefined,
    registry,
    forceRegistryConfig,
  );

  if (fork) {
    await governor.checkChain(fork);
    if (govern) {
      await governor.govern(false, fork);
    }
  } else {
    await governor.check(chains);
    if (govern) {
      await governor.govern();
    }
  }

  if (!govern) {
    const violations = governor.getCheckerViolations();
    if (violations.length > 0) {
      logViolations(violations);

      if (!fork) {
        throw new Error(
          `Checking ${module} deploy yielded ${violations.length} violations`,
        );
      }
    } else {
      console.info(`${module} checker found no violations`);
    }
  }

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

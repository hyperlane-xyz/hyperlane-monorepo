import chalk from 'chalk';
import { Gauge, Registry } from 'prom-client';

import { ChainName } from '@hyperlane-xyz/sdk';

import { getWarpAddresses } from '../../config/registry.js';
import { warpConfigGetterMap } from '../../config/warp.js';
import { submitMetrics } from '../../src/utils/metrics.js';
import { Modules, getWarpRouteIdsInteractive } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

import {
  getCheckWarpDeployArgs,
  getCheckerViolationsGaugeObj,
  getGovernor,
  logViolations,
} from './check-utils.js';

async function main() {
  const {
    environment,
    asDeployer,
    chains,
    fork,
    context,
    pushMetrics,
    interactive,
  } = await getCheckWarpDeployArgs().argv;

  const metricsRegister = new Registry();
  const checkerViolationsGauge = new Gauge(
    getCheckerViolationsGaugeObj(metricsRegister),
  );
  metricsRegister.registerMetric(checkerViolationsGauge);

  const failedWarpRoutesChecks: string[] = [];

  let warpIdsToCheck = Object.keys(warpConfigGetterMap);
  if (interactive) {
    warpIdsToCheck = await getWarpRouteIdsInteractive();
  }

  // Determine which chains have warp configs
  const chainsWithWarpConfigs = warpIdsToCheck.reduce((chains, warpRouteId) => {
    const warpAddresses = getWarpAddresses(warpRouteId);
    Object.keys(warpAddresses).forEach((chain) => chains.add(chain));
    return chains;
  }, new Set<ChainName>());

  console.log(
    `Found warp configs for chains: ${Array.from(chainsWithWarpConfigs).join(
      ', ',
    )}`,
  );

  // Get the multiprovider once to avoid recreating it for each warp route
  // We specify the chains to avoid creating a multiprovider for all chains.
  // This ensures that we don't fail to fetch secrets for new chains in the cron job.
  const envConfig = getEnvironmentConfig(environment);
  // Use default values for context, role, and useSecrets
  const multiProvider = await envConfig.getMultiProvider(
    undefined,
    undefined,
    undefined,
    Array.from(chainsWithWarpConfigs),
  );

  // TODO: consider retrying this if check throws an error
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`\nChecking warp route ${warpRouteId}...`);
    const warpModule = Modules.WARP;

    try {
      const governor = await getGovernor(
        warpModule,
        context,
        environment,
        asDeployer,
        warpRouteId,
        chains,
        fork,
        false,
        multiProvider,
      );

      await governor.check();

      const violations: any = governor.getCheckerViolations();
      if (violations.length > 0) {
        logViolations(violations);

        if (pushMetrics) {
          for (const violation of violations) {
            checkerViolationsGauge
              .labels({
                module: warpModule,
                warp_route_id: warpRouteId,
                chain: violation.chain,
                contract_name: violation.name,
                type: violation.type,
                actual: violation.actual,
                expected: violation.expected,
              })
              .set(1);
            console.log(
              `Violation: ${violation.name} on ${violation.chain} with ${violation.actual} ${violation.type} ${violation.expected} pushed to metrics`,
            );
          }
        }
      } else {
        console.info(chalk.green(`${warpModule} checker found no violations`));
      }

      if (pushMetrics) {
        await submitMetrics(
          metricsRegister,
          `check-warp-deploy-${environment}`,
          {
            overwriteAllMetrics: true,
          },
        );
      }
    } catch (e) {
      console.error(
        chalk.red(`Error checking warp route ${warpRouteId}: ${e}`),
      );
      failedWarpRoutesChecks.push(warpRouteId);
    }
  }

  if (failedWarpRoutesChecks.length > 0) {
    console.error(
      chalk.red(
        `Failed to check warp routes: ${failedWarpRoutesChecks.join(', ')}`,
      ),
    );
    process.exit(1);
  }

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

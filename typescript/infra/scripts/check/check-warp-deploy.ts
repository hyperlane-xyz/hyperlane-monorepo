import chalk from 'chalk';
import { Gauge, Registry } from 'prom-client';

import { warpConfigGetterMap } from '../../config/warp.js';
import { submitMetrics } from '../../src/utils/metrics.js';
import { Modules } from '../agent-utils.js';

import {
  getCheckWarpDeployArgs,
  getCheckerViolationsGaugeObj,
  getGovernor,
  logViolations,
} from './check-utils.js';

async function main() {
  const { environment, asDeployer, chains, fork, context, pushMetrics } =
    await getCheckWarpDeployArgs().argv;

  const metricsRegister = new Registry();
  const checkerViolationsGauge = new Gauge(
    getCheckerViolationsGaugeObj(metricsRegister),
  );
  metricsRegister.registerMetric(checkerViolationsGauge);

  const failedWarpRoutesChecks: string[] = [];

  for (const warpRouteId of Object.keys(warpConfigGetterMap)) {
    console.log(`\nChecking warp route ${warpRouteId}...`);
    const warpModule = Modules.WARP;

    let retryCount = 0; // Initialize retry count
    const maxRetries = 3; // Set maximum number of retries

    while (retryCount < maxRetries) {
      // Retry loop
      try {
        const governor = await getGovernor(
          warpModule,
          context,
          environment,
          asDeployer,
          warpRouteId,
          chains,
          fork,
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
          console.info(
            chalk.green(`${warpModule} checker found no violations`),
          );
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
        break; // Exit the retry loop if successful
      } catch (e) {
        retryCount++; // Increment retry count
        console.error(
          chalk.red(`Error checking warp route ${warpRouteId}: ${e}`),
        );
        if (retryCount >= maxRetries) {
          failedWarpRoutesChecks.push(warpRouteId); // Add to failed checks if max retries reached
        } else {
          console.log(`Retrying... (${retryCount}/${maxRetries})`); // Log retry attempt
        }
      }
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

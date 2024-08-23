import chalk from 'chalk';
import { Gauge, Registry } from 'prom-client';

import { WarpRouteIds } from '../../config/warp.js';
import { submitMetrics } from '../../src/utils/metrics.js';
import { Modules } from '../agent-utils.js';

import {
  getCheckWarpDeployArgs,
  getGovernor,
  logViolations,
} from './check-utils.js';

async function main() {
  const { environment, asDeployer, chain, fork, context, pushMetrics } =
    await getCheckWarpDeployArgs().argv;

  const metricsRegister = new Registry();
  const checkerViolationsGauge = new Gauge({
    name: 'hyperlane_check_violations',
    help: 'Checker violation',
    registers: [metricsRegister],
    labelNames: [
      'module',
      'warp_route_id',
      'chain',
      'remote',
      'contract_name',
      'type',
      'sub_type',
      'actual',
      'expected',
    ],
  });
  metricsRegister.registerMetric(checkerViolationsGauge);

  // TODO: consider retrying this if check throws an error
  for (const warpRouteId of Object.values(WarpRouteIds)) {
    console.log(`\nChecking warp route ${warpRouteId}...`);
    const warpModule = Modules.WARP;

    try {
      const governor = await getGovernor(
        warpModule,
        context,
        environment,
        asDeployer,
        warpRouteId,
        chain,
        fork,
      );

      await governor.checker.check();

      const violations: any = governor.checker.violations;
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
      console.log(chalk.red(`Error checking warp route ${warpRouteId}: ${e}`));
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

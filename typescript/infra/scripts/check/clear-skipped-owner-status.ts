import chalk from 'chalk';
import { Registry } from 'prom-client';

import { deleteMetrics } from '@hyperlane-xyz/metrics';

import { checkWarpDeployConfig } from '../../config/environments/mainnet3/warp/checkWarpDeploy.js';
import { getArgs } from '../agent-utils.js';

import { warpViolationGroupings } from './check-utils.js';
import { ownerStatusClearTargets } from './owner-status-skip.js';

// One-time rollout clear for the legacy-EOA ownerStatus allowlist.
//
// Adding a route to OWNER_STATUS_SKIP only stops the checker from refreshing the
// matching violation; a series already firing at 1 in PushGateway is never
// touched by the checker (by design — see pushWarpViolationsMetrics), so it would
// stay firing forever. This script deletes exactly the series that the allowlist
// now suppresses, derived from OWNER_STATUS_SKIP so the two can never drift.
// Idempotent: deleting an already-absent series is a no-op.
async function main() {
  const { environment, pushGateway } = await getArgs()
    .describe(
      'pushGateway',
      'PushGateway address; defaults to PROMETHEUS_PUSH_GATEWAY or the env config',
    )
    .string('pushGateway').argv;

  const gatewayAddr =
    pushGateway ??
    process.env['PROMETHEUS_PUSH_GATEWAY'] ??
    checkWarpDeployConfig.prometheusPushGateway;
  process.env['PROMETHEUS_PUSH_GATEWAY'] = gatewayAddr;

  const targets = ownerStatusClearTargets();
  console.log(
    chalk.yellow(
      `Clearing ${targets.length} skipped ownerStatus series via ${gatewayAddr}`,
    ),
  );

  let cleared = 0;
  for (const { warpRouteId, chain, contractName, violationType } of targets) {
    const groupings = warpViolationGroupings(
      warpRouteId,
      chain,
      contractName,
      violationType,
    );
    console.log(
      chalk.yellow(
        `[${cleared + 1}/${targets.length}] ${violationType} ${warpRouteId} ${chain} "${contractName}"`,
      ),
    );
    await deleteMetrics(
      new Registry(),
      `check-warp-deploy-${environment}`,
      groupings,
    );
    cleared++;
  }

  console.log(chalk.green(`Delete requests sent for ${cleared} series`));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

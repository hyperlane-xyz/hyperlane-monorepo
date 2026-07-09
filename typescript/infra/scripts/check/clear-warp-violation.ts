import chalk from 'chalk';
import { Registry } from 'prom-client';

import { deleteMetrics } from '@hyperlane-xyz/metrics';

import { checkWarpDeployConfig } from '../../config/environments/mainnet3/warp/checkWarpDeploy.js';
import { getArgs } from '../agent-utils.js';

import { warpViolationGroupings } from './check-utils.js';

// Human-confirmed clearing of a single hyperlane_check_violations alert.
//
// The daily checker never auto-clears a violation: it only ever pushes/refreshes
// series it actually observes, each under its own PushGateway group. This script
// is the only way a series is removed, and it is meant to be invoked explicitly
// (e.g. by Haggis) once a human confirms the underlying config/registry drift is
// resolved. It DELETEs exactly the one group identified by the labels, leaving
// every other violation untouched.
async function main() {
  const {
    environment,
    warpRouteId,
    chain,
    contractName,
    violationType,
    pushGateway,
  } = await getArgs()
    .describe('warpRouteId', 'Warp route id of the violation, e.g. USDC/...')
    .string('warpRouteId')
    .demandOption('warpRouteId')
    .describe('chain', 'Chain of the violation')
    .string('chain')
    .demandOption('chain')
    .describe('contractName', 'Contract name of the violation (may be empty)')
    .string('contractName')
    .default('contractName', '')
    .describe('violationType', 'Violation type, e.g. Owner')
    .string('violationType')
    .demandOption('violationType')
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

  const groupings = warpViolationGroupings(
    warpRouteId,
    chain,
    contractName,
    violationType,
  );

  console.log(
    chalk.yellow(
      `Clearing violation ${violationType} for ${warpRouteId} on ${chain} (contract "${contractName}")`,
    ),
  );
  console.log(chalk.yellow(`Grouping: ${JSON.stringify(groupings)}`));

  // Registry is only used to resolve the gateway; no metrics are pushed.
  await deleteMetrics(
    new Registry(),
    `check-warp-deploy-${environment}`,
    groupings,
  );

  console.log(chalk.green('Delete request sent to PushGateway'));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

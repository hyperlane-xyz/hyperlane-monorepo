import chalk from 'chalk';
import { Registry } from 'prom-client';

import { deleteMetrics } from '@hyperlane-xyz/metrics';

import { monorepoChecksConfig } from '../../../config/environments/mainnet3/monorepoChecks.js';
import { getArgs } from '../../agent-utils.js';
import { checkerViolationGroupings } from '../../check/check-utils.js';

import { FastpathIsmViolationType } from './check-fastpath-isms.js';

const FASTPATH_VIOLATION_TYPES: FastpathIsmViolationType[] = [
  'missing',
  'moduleType',
  'validators',
  'threshold',
];

// Human-confirmed clearing of a single fastpath hyperlane_check_violations
// series. Like the warp checker, the fastpath check only ever pushes/refreshes
// series it actually observes: after a real mismatch is fixed a successful run
// pushes nothing, so its PushGateway group would otherwise page indefinitely.
// This deletes exactly the one group identified by (chain, violationType),
// leaving every other violation untouched, and is meant to be invoked
// explicitly once a human confirms the drift is resolved.
async function main() {
  const { environment, chain, violationType, pushGateway } = await getArgs()
    .describe('chain', 'Destination chain of the fastpath ISM violation')
    .string('chain')
    .demandOption('chain')
    .describe('violationType', 'Violation type')
    .choices('violationType', FASTPATH_VIOLATION_TYPES)
    .demandOption('violationType')
    .describe(
      'pushGateway',
      'PushGateway address; defaults to PROMETHEUS_PUSH_GATEWAY or the env config',
    )
    .string('pushGateway').argv;

  const gatewayAddr =
    pushGateway ??
    process.env['PROMETHEUS_PUSH_GATEWAY'] ??
    monorepoChecksConfig.prometheusPushGateway;
  process.env['PROMETHEUS_PUSH_GATEWAY'] = gatewayAddr;

  // Must match the grouping used by pushFastpathIsmViolationMetrics.
  const groupings = checkerViolationGroupings([
    'fastpath-ism',
    chain,
    'ism',
    violationType,
  ]);

  console.log(
    chalk.yellow(
      `Clearing fastpath ISM violation ${violationType} on ${chain}`,
    ),
  );
  console.log(chalk.yellow(`Grouping: ${JSON.stringify(groupings)}`));

  // Registry is only used to resolve the gateway; no metrics are pushed.
  await deleteMetrics(
    new Registry(),
    `fastpath-isms-${environment}`,
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

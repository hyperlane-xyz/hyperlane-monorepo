import chalk from 'chalk';
import { readFileSync } from 'fs';
import { Registry } from 'prom-client';

import { deleteMetrics } from '@hyperlane-xyz/metrics';

import { checkWarpDeployConfig } from '../../config/environments/mainnet3/warp/checkWarpDeploy.js';
import { getArgs } from '../agent-utils.js';

import { warpViolationGroupings } from './check-utils.js';

// Batch variant of clear-warp-violation.ts: clears many series in a single
// process to avoid per-series tsx cold starts. Reads a TSV file whose columns
// are: warp_route_id, chain, contract_name, type.
async function main() {
  const { environment, file, pushGateway } = await getArgs()
    .describe(
      'file',
      'TSV file: warp_route_id<TAB>chain<TAB>contract_name<TAB>type',
    )
    .string('file')
    .demandOption('file')
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

  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split('\t'));

  console.log(
    chalk.yellow(`Clearing ${rows.length} violation series via ${gatewayAddr}`),
  );

  let ok = 0;
  for (const [warpRouteId, chain, contractName, violationType] of rows) {
    const groupings = warpViolationGroupings(
      warpRouteId,
      chain,
      contractName ?? '',
      violationType,
    );
    console.log(
      chalk.yellow(
        `[${ok + 1}/${rows.length}] ${violationType} ${warpRouteId} ${chain} "${contractName}"`,
      ),
    );
    await deleteMetrics(
      new Registry(),
      `check-warp-deploy-${environment}`,
      groupings,
    );
    ok++;
  }

  console.log(chalk.green(`Delete requests sent for ${ok} series`));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

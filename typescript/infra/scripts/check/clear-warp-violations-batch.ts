import chalk from 'chalk';
import { readFileSync } from 'fs';

import { assert } from '@hyperlane-xyz/utils';

import { checkWarpDeployConfig } from '../../config/environments/mainnet3/warp/checkWarpDeploy.js';
import { getArgs } from '../agent-utils.js';

import { warpViolationGroupings } from './check-utils.js';
import { deleteViolationSeriesOrThrow } from './clear-utils.js';

// Batch variant of clear-warp-violation.ts: clears many series in a single
// process to avoid per-series tsx cold starts. Reads a TSV file whose columns
// are: warp_route_id, chain, contract_name, type.

interface ClearRow {
  warpRouteId: string;
  chain: string;
  contractName: string;
  violationType: string;
}

const HEADER = ['warp_route_id', 'chain', 'contract_name', 'type'];

// Parse and fully validate the TSV before any mutation, so a malformed row can
// never be silently coerced into a no-op DELETE (or partially applied after
// earlier rows were already cleared). Requires exactly four tab-separated
// columns with non-empty route/chain/type; contract_name may be empty. Throws
// listing every offending line.
function parseRows(contents: string): ClearRow[] {
  const errors: string[] = [];
  const rows: ClearRow[] = [];
  contents.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) {
      return;
    }
    const cols = line.split('\t');
    // Tolerate a single leading header row.
    if (idx === 0 && HEADER.every((h, i) => cols[i]?.trim() === h)) {
      return;
    }
    const lineNo = idx + 1;
    if (cols.length !== 4) {
      errors.push(`line ${lineNo}: expected 4 tab-columns, got ${cols.length}`);
      return;
    }
    // Trim every field so the derived PushGateway grouping key matches the
    // stored series exactly: a stray space would change alert_key, and DELETE
    // still returns 202 on a miss, so an untrimmed row could report success
    // while leaving the real series firing.
    const [warpRouteId, chain, contractName, violationType] = cols.map((c) =>
      c.trim(),
    );
    if (warpRouteId === '' || chain === '') {
      errors.push(`line ${lineNo}: warp_route_id and chain must be non-empty`);
      return;
    }
    if (violationType === '') {
      errors.push(`line ${lineNo}: type must be non-empty`);
      return;
    }
    rows.push({ warpRouteId, chain, contractName, violationType });
  });

  assert(
    errors.length === 0,
    `Refusing to clear: malformed TSV (no series deleted):\n  ${errors.join('\n  ')}`,
  );
  assert(rows.length > 0, 'TSV contained no data rows');
  return rows;
}

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

  const rows = parseRows(readFileSync(file, 'utf8'));

  console.log(
    chalk.yellow(`Clearing ${rows.length} violation series via ${gatewayAddr}`),
  );

  const jobName = `check-warp-deploy-${environment}`;
  let ok = 0;
  const failures: string[] = [];
  for (const [
    i,
    { warpRouteId, chain, contractName, violationType },
  ] of rows.entries()) {
    const groupings = warpViolationGroupings(
      warpRouteId,
      chain,
      contractName,
      violationType,
    );
    const label = `${violationType} ${warpRouteId} ${chain} "${contractName}"`;
    console.log(chalk.yellow(`[${i + 1}/${rows.length}] ${label}`));
    try {
      await deleteViolationSeriesOrThrow(jobName, groupings);
      ok++;
    } catch (e) {
      failures.push(label);
      console.error(chalk.red(`  failed: ${e}`));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Cleared ${ok}/${rows.length}; ${failures.length} failed:\n  ${failures.join('\n  ')}`,
    );
  }
  console.log(chalk.green(`Cleared ${ok} series`));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

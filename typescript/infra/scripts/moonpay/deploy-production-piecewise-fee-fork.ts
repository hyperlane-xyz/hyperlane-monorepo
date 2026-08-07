#!/usr/bin/env tsx
/**
 * Default zero-write preview:
 *   pnpm tsx scripts/moonpay/deploy-production-piecewise-fee-fork.ts
 *
 * BSC fork execution (the only supported write mode):
 *   anvil --fork-url "$RPC_URL_BSC" --block-time 1
 *   pnpm tsx scripts/moonpay/deploy-production-piecewise-fee-fork.ts --apply --fork
 */

import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  formatProductionPiecewiseForkResult,
  runProductionPiecewiseFork,
} from './deploy-production-piecewise-fee-fork-lib.js';

async function main(): Promise<void> {
  const { apply, fork } = await yargs(process.argv.slice(2))
    .strict()
    .option('apply', {
      type: 'boolean',
      default: false,
      description: 'Enable writes; accepted only together with --fork.',
    })
    .option('fork', {
      type: 'boolean',
      default: false,
      description:
        'Use the local BSC fork at http://127.0.0.1:8545. Live mode does not exist.',
    })
    .parseAsync();

  console.log(
    JSON.stringify(
      formatProductionPiecewiseForkResult(
        await runProductionPiecewiseFork({ apply, fork }),
      ),
      null,
      2,
    ),
  );
}

main().catch((error) => {
  rootLogger.error(error, 'Production piecewise fork validation failed');
  process.exitCode = 1;
});

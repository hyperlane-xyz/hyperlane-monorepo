#!/usr/bin/env tsx
/**
 * Default zero-write preview:
 *   pnpm tsx scripts/moonpay/deploy-staging-piecewise-fee.ts
 *
 * Fork execution:
 *   anvil --fork-url "$RPC_URL_BSC" --block-time 1
 *   pnpm tsx scripts/moonpay/deploy-staging-piecewise-fee.ts --apply --fork
 *
 * A live apply additionally requires --confirm-router with the exact guarded
 * staging address. This script never updates any non-BSC router.
 */

import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  formatStagingFeeDeploymentResult,
  runStagingFeeDeployment,
} from './deploy-staging-piecewise-fee-lib.js';

async function main(): Promise<void> {
  const { apply, fork, confirmRouter } = await yargs(process.argv.slice(2))
    .strict()
    .option('apply', {
      type: 'boolean',
      default: false,
      description:
        'Enable deployments and writes. Omit for the default zero-write dry run.',
    })
    .option('fork', {
      type: 'boolean',
      default: false,
      description:
        'Use a BSC Anvil/Hardhat fork at http://127.0.0.1:8545 and impersonate the deployer. Start Anvil with --block-time 1.',
    })
    .option('confirm-router', {
      type: 'string',
      description:
        'Required for a live apply; must equal the guarded BSC USDT staging router.',
    })
    .parseAsync();

  const result = await runStagingFeeDeployment({
    apply,
    fork,
    confirmRouter,
  });
  console.log(
    JSON.stringify(formatStagingFeeDeploymentResult(result), null, 2),
  );
}

main().catch((error) => {
  rootLogger.error(error, 'Staging piecewise fee deployment failed');
  process.exitCode = 1;
});

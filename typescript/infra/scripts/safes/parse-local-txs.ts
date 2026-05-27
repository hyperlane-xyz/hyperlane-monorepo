/**
 * Decodes a locally-saved Gnosis Safe batch JSON (e.g. from `warp apply`)
 * into human-readable form, including ICA-nested transactions.
 *
 * Usage:
 *   ts-node parse-local-txs.ts --file /path/to/batch.json --chain ethereum [--governanceType regular]
 */
import chalk from 'chalk';
import { BigNumber } from 'ethers';
import { readFileSync } from 'fs';
import yargs from 'yargs';

import { AnnotatedEV5Transaction } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';
import { writeYaml } from '@hyperlane-xyz/utils/fs';

import { withGovernanceType } from '../../src/governance.js';
import {
  GovernTransaction,
  GovernTransactionReader,
} from '../../src/tx/govern-transaction-reader.js';
import { withChains } from '../agent-utils.js';

const environment = 'mainnet3';

interface SafeBatchTx {
  to: string;
  value: string;
  data: string;
  operation: number;
}

interface SafeBatchJson {
  chainId: string;
  transactions: SafeBatchTx[];
}

async function main() {
  const { chain, file, out, governanceType } = await withGovernanceType(
    withChains(
      yargs(process.argv.slice(2))
        .option('file', {
          type: 'string',
          description: 'Path to the Safe batch JSON file',
          demandOption: true,
        })
        .option('chain', {
          type: 'string',
          description: 'Chain name for the batch (e.g. ethereum, polygon)',
          demandOption: true,
        })
        .option('out', {
          type: 'string',
          description: 'Write results to this file path (YAML)',
        }),
    ),
  ).argv;

  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const raw = readFileSync(file, 'utf8');
  const batch: SafeBatchJson = JSON.parse(raw);

  rootLogger.info(
    chalk.blue(
      `Parsing ${batch.transactions.length} transaction(s) on chain "${chain}" from ${file}`,
    ),
  );

  const reader = await GovernTransactionReader.create(
    environment,
    governanceType,
  );

  const results: [string, GovernTransaction][] = [];
  const pad = String(batch.transactions.length - 1).length;

  for (let i = 0; i < batch.transactions.length; i++) {
    const raw = batch.transactions[i];
    const tx: AnnotatedEV5Transaction = {
      to: raw.to,
      data: raw.data || undefined,
      value: BigNumber.from(raw.value || '0'),
    };

    const key = `tx-${String(i).padStart(pad, '0')}`;
    rootLogger.info(chalk.gray.italic(`Reading tx ${i} on ${chain}...`));
    try {
      const result = await reader.read(chain, tx);
      results.push([key, result]);
    } catch (err) {
      rootLogger.error(chalk.red(`Error reading tx ${i}:`, err));
      results.push([
        key,
        { chain, insight: `❌ failed to decode: ${err}`, raw: tx },
      ]);
    }
  }

  if (reader.errors.length) {
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
    rootLogger.info(stringifyObject(reader.errors, 'yaml', 2));
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
  } else {
    rootLogger.info(chalk.green('✅✅✅✅✅ No fatal errors ✅✅✅✅✅'));
  }

  const chainResults = Object.fromEntries(results);
  const yaml = stringifyObject(chainResults, 'yaml', 2);
  console.log(yaml);

  if (out) {
    writeYaml(out, chainResults);
    rootLogger.info(`Results written to ${out}`);
  }

  if (reader.errors.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});

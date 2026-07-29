import { BigNumber } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';

import { assert, rootLogger } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../config/contexts.js';
import { SafeMultiSend } from '../../src/govern/multisend.js';
import { Role } from '../../src/roles.js';
import { withPropose } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

type TxFile = {
  version: string;
  chainId: string;
  meta: unknown;
  transactions: Array<{ to: string; value: string; data: string }>;
};

async function main() {
  const { directory, file, safeAddress, propose } = await withPropose(
    yargs(process.argv.slice(2))
      .option('directory', {
        type: 'string',
        describe:
          'Directory containing combined tx JSON files (output of combine-txs)',
        alias: 'd',
      })
      .option('file', {
        type: 'string',
        describe: 'Single combined tx JSON file to propose',
        alias: 'f',
      })
      .option('safe-address', {
        type: 'string',
        describe: 'Safe address to propose transactions to',
        demandOption: true,
        alias: 's',
      })
      .check((argv) => {
        if (!argv.directory && !argv.file) {
          throw new Error('Must provide either --directory or --file');
        }
        if (argv.directory && argv.file) {
          throw new Error('Cannot provide both --directory and --file');
        }
        return true;
      }),
  ).argv;

  let filePaths: string[];
  if (file) {
    if (!fs.existsSync(file)) {
      rootLogger.error(`File ${file} does not exist`);
      process.exit(1);
    }
    filePaths = [file];
  } else {
    assert(directory, 'missing --directory flag');
    if (!fs.existsSync(directory)) {
      rootLogger.error(`Directory ${directory} does not exist`);
      process.exit(1);
    }
    const entries = fs
      .readdirSync(directory)
      .filter((f) => path.extname(f) === '.json');
    if (entries.length === 0) {
      rootLogger.error(`No JSON files found in ${directory}`);
      process.exit(1);
    }
    filePaths = entries.map((f) => path.join(directory, f));
  }

  const config = getEnvironmentConfig('mainnet3');
  const multiProvider = await config.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
  );

  for (const filePath of filePaths) {
    let txFile: TxFile;
    try {
      txFile = readJson<TxFile>(filePath);
    } catch (error) {
      rootLogger.error(`Failed to parse ${filePath}, skipping:`, error);
      continue;
    }

    const chainId = txFile.chainId;
    let chainName: string;
    try {
      chainName = multiProvider.getChainName(chainId);
    } catch {
      rootLogger.error(
        `Could not resolve chain name for chainId ${chainId} (${filePath}), skipping`,
      );
      continue;
    }

    rootLogger.info(
      `[${chainName}] Found ${txFile.transactions.length} transaction(s) in ${filePath}`,
    );

    if (!propose) {
      rootLogger.info(`[${chainName}] Dry run — pass --propose to submit`);
      continue;
    }

    let safeMultiSend: SafeMultiSend;
    try {
      safeMultiSend = await SafeMultiSend.initialize(
        multiProvider,
        chainName,
        safeAddress,
      );
    } catch (error) {
      rootLogger.error(
        `[${chainName}] Could not initialize SafeMultiSend: ${error}`,
      );
      continue;
    }

    try {
      const hashes = await safeMultiSend.sendTransactions(
        txFile.transactions.map((tx) => ({
          to: tx.to,
          data: tx.data,
          value: BigNumber.from(tx.value),
        })),
      );
      rootLogger.info(`[${chainName}] Successfully proposed transactions`);
      for (const hash of hashes) {
        rootLogger.info(`[${chainName}] safeTxHash: ${hash}`);
      }
    } catch (error) {
      rootLogger.error(
        `[${chainName}] Failed to propose transactions: ${error}`,
      );
    }
  }

  if (!propose) {
    rootLogger.info('Pass --propose to submit transactions to the Safe');
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});

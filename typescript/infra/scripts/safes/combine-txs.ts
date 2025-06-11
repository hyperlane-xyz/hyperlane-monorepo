// Import necessary modules
import { SafeTransaction } from '@safe-global/safe-core-sdk-types';
// eslint-disable-next-line
import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

import { readJSONAtPath, writeJsonAtPath } from '../../src/utils/utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

type TxFile = {
  version: string;
  chainId: string;
  meta: any;
  transactions: SafeTransaction[];
};

// Function to read and parse JSON files
function readJSONFiles(directory: string): Record<string, TxFile[]> {
  const files = fs.readdirSync(directory);
  const transactionsByChainId: Record<string, TxFile[]> = {};

  for (const file of files) {
    if (path.extname(file) === '.json') {
      const filePath = path.join(directory, file);
      const txs: TxFile = readJSONAtPath(filePath);
      const chainId = txs.chainId;
      if (!transactionsByChainId[chainId]) {
        transactionsByChainId[chainId] = [];
      }
      transactionsByChainId[chainId].push(txs);
    }
  }

  return transactionsByChainId;
}

// Function to write combined transactions to new JSON files
async function writeCombinedTransactions(
  transactionsByChainId: Record<string, TxFile[]>,
  directory: string,
) {
  // Create the output directory
  const outputDir = path.join(directory, `combined-txs-${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const config = getEnvironmentConfig('mainnet3');
  const multiProvider = await config.getMultiProvider();

  for (const [chainId, transactions] of Object.entries(transactionsByChainId)) {
    // Create the output data
    const outputData = {
      version: '1.0',
      chainId: chainId,
      meta: {},
      transactions: transactions.flatMap((txFile) => txFile.transactions),
    };

    // Write the output file
    // NOTE: hacky use of chainid instead of domainid or chain name here
    const chainName = multiProvider.getChainName(chainId);
    const outputFilePath = path.join(outputDir, `${chainId}-${chainName}.json`);
    writeJsonAtPath(outputFilePath, outputData);
    rootLogger.info(`Combined transactions written to ${outputFilePath}`);
  }
}

// Main function to execute the script
async function main() {
  const { directory } = await yargs(process.argv.slice(2)).option('directory', {
    type: 'string',
    describe: 'directory containing txs',
    demandOption: true,
    alias: 'd',
  }).argv;

  if (!fs.existsSync(directory)) {
    rootLogger.error(`Directory ${directory} does not exist`);
    process.exit(1);
  }

  const transactionsByChainId = readJSONFiles(directory);
  await writeCombinedTransactions(transactionsByChainId, directory);
}

// Execute the main function and handle promise
main().catch((error) => {
  rootLogger.error('An error occurred:', error);
  process.exit(1);
});

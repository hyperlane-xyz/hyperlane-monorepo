import fs from 'fs';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  SquadsTransaction,
  SquadsTransactionReader,
  SvmMultisigConfigMap,
  getSquadsChains,
  getPendingProposalsForChains,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { processGovernorReaderResult } from '../../src/tx/utils.js';
import { Contexts } from '../../config/contexts.js';
import { logProposals } from './cli-helpers.js';

const environment = 'mainnet3';

async function main() {
  const { chains } = await yargs(process.argv.slice(2))
    .describe('chains', 'Set of chains to perform actions on.')
    .array('chains')
    .choices('chains', getSquadsChains())
    .coerce('chains', (selectedChains: string[] = []) =>
      Array.from(new Set(selectedChains)),
    )
    .alias('c', 'chains').argv;
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { getEnvironmentConfig } = await import('../core-utils.js');
  const { loadCoreProgramIds, multisigIsmConfigPath } =
    await import('../../src/utils/sealevel.js');

  // Get the multiprovider for the environment
  const config = getEnvironmentConfig(environment);
  const mpp = await config.getMultiProtocolProvider();

  // Load warp routes from registry
  const registry = await config.getRegistry();
  const warpRoutes = await registry.getWarpRoutes();

  // Initialize the transaction reader
  const reader = new SquadsTransactionReader(mpp, {
    resolveCoreProgramIds: (chain) => loadCoreProgramIds(environment, chain),
    resolveExpectedMultisigConfig: (chain) => {
      const configPath = multisigIsmConfigPath(
        environment,
        Contexts.Hyperlane,
        chain,
      );
      if (!fs.existsSync(configPath)) return null;
      return readJson(configPath) as SvmMultisigConfigMap;
    },
  });
  await reader.init(warpRoutes);

  // Get the pending proposals for the relevant chains
  const chainsToCheck =
    !chains || chains.length === 0 ? getSquadsChains() : chains;

  const pendingProposals = await getPendingProposalsForChains(
    chainsToCheck,
    mpp,
  );

  if (pendingProposals.length === 0) {
    rootLogger.info(chalk.green('No pending proposals found!'));
    process.exit(0);
  }

  logProposals(pendingProposals);

  // Parse each proposal and collect results
  const chainResultEntries = await Promise.all(
    pendingProposals.map(
      async ({
        chain,
        nonce,
        fullTxHash,
      }): Promise<[string, SquadsTransaction]> => {
        rootLogger.info(
          chalk.gray.italic(
            `Parsing proposal ${nonce} (${fullTxHash}) on ${chain}...`,
          ),
        );

        try {
          const result = await reader.read(chain, nonce);
          rootLogger.info(
            chalk.blue(`Finished parsing proposal ${nonce} on ${chain}`),
          );
          return [`${chain}-${nonce}-${fullTxHash}`, result];
        } catch (error) {
          rootLogger.error(
            chalk.red(`Error parsing proposal ${nonce} on ${chain}:`),
            error,
          );
          return [`${chain}-${nonce}-${fullTxHash}`, { chain, error }];
        }
      },
    ),
  );

  // Process results and write to file
  processGovernorReaderResult(
    chainResultEntries,
    reader.errors,
    'squads-tx-parse-results',
  );
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});

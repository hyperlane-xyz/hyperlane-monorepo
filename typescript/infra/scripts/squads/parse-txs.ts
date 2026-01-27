import chalk from 'chalk';
import fs from 'fs';
import yargs from 'yargs';

import {
  ChainMap,
  SquadsTransaction,
  SquadsTransactionReader,
  SvmCoreProgramIds,
  SvmMultisigConfigMap,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { squadsConfigs } from '../../src/config/squads.js';
import { processGovernorReaderResult } from '../../src/tx/utils.js';
import {
  getPendingProposalsForChains,
  logProposals,
} from '../../src/utils/squads.js';
import { loadCoreProgramIds, multisigIsmConfigPath } from '../../src/utils/sealevel.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

async function main() {
  const { chains } = await withChains(
    yargs(process.argv.slice(2)),
    Object.keys(squadsConfigs),
  ).argv;
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  // Get the multiprovider for the environment
  const config = getEnvironmentConfig(environment);
  const mpp = await config.getMultiProtocolProvider();

  // Load warp routes from registry
  const registry = await config.getRegistry();
  const warpRoutes = await registry.getWarpRoutes();

  const chainsToCheck =
    !chains || chains.length === 0 ? Object.keys(squadsConfigs) : chains;

  const coreProgramIdsByChain: ChainMap<SvmCoreProgramIds> = {};
  const expectedMultisigConfigsByChain: ChainMap<SvmMultisigConfigMap> = {};
  for (const chain of chainsToCheck) {
    coreProgramIdsByChain[chain] = loadCoreProgramIds(environment, chain);

    const configPath = multisigIsmConfigPath(
      environment,
      Contexts.Hyperlane,
      chain,
    );
    if (!fs.existsSync(configPath)) {
      rootLogger.warn(`No multisig config found at ${configPath}`);
      continue;
    }
    expectedMultisigConfigsByChain[chain] = JSON.parse(
      fs.readFileSync(configPath, 'utf-8'),
    ) as SvmMultisigConfigMap;
  }

  // Initialize the transaction reader
  const reader = new SquadsTransactionReader({
    mpp,
    squadsConfigByChain: squadsConfigs,
    coreProgramIdsByChain,
    expectedMultisigConfigsByChain,
  });
  await reader.init(warpRoutes);

  // Get the pending proposals for the relevant chains
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

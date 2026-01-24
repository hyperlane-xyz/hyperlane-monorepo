import chalk from 'chalk';
import fs from 'fs';
import yargs from 'yargs';

import {
  type CoreProgramIds,
  type SquadsChainConfigInput,
  type SquadsTransaction,
  SquadsTransactionReader,
  type SvmMultisigConfigMap,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../src/config/contexts.js';
import { squadsConfigs } from '../../src/config/squads.js';
import { processGovernorReaderResult } from '../../src/tx/utils.js';
import {
  loadCoreProgramIds,
  multisigIsmConfigPath,
} from '../../src/utils/sealevel.js';
import {
  getPendingProposalsForChains,
  logProposals,
} from '../../src/utils/squads.js';
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

  // Initialize the transaction reader
  const chainConfigs: Record<string, SquadsChainConfigInput> = {};
  for (const [chain, squadsConfig] of Object.entries(squadsConfigs)) {
    let coreProgramIds: CoreProgramIds | undefined;
    try {
      coreProgramIds = loadCoreProgramIds(environment, chain);
    } catch (error) {
      rootLogger.warn(
        chalk.yellow(`Failed to load core program IDs for ${chain}: ${error}`),
      );
    }

    let expectedMultisigIsm: SvmMultisigConfigMap | undefined;
    try {
      const configPath = multisigIsmConfigPath(
        environment,
        Contexts.Hyperlane,
        chain,
      );
      if (fs.existsSync(configPath)) {
        expectedMultisigIsm = JSON.parse(
          fs.readFileSync(configPath, 'utf-8'),
        ) as SvmMultisigConfigMap;
      }
    } catch (error) {
      rootLogger.warn(
        chalk.yellow(
          `Failed to load expected multisig config for ${chain}: ${error}`,
        ),
      );
    }

    chainConfigs[chain] = {
      multisigPda: squadsConfig.multisigPda,
      programId: squadsConfig.programId,
      coreProgramIds,
      expectedMultisigIsm,
    };
  }

  const reader = new SquadsTransactionReader(mpp, {
    chainConfigs,
  });
  await reader.init(warpRoutes);

  // Get the pending proposals for the relevant chains
  const chainsToCheck =
    !chains || chains.length === 0 ? Object.keys(squadsConfigs) : chains;

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

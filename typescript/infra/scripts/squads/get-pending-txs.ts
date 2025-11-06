import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import { ChainMap, SvmMultiProtocolSignerAdapter } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { squadsConfigs } from '../../src/config/squads.js';
import { executePendingTransactions } from '../../src/tx/utils.js';
import {
  SquadTxStatus,
  executeProposal,
  getPendingProposalsForChains,
  logProposals,
} from '../../src/utils/squads.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chains } = await withChains(
    yargs(process.argv.slice(2)),
    Object.keys(squadsConfigs),
  ).argv;

  const squadChains = Object.keys(squadsConfigs);
  const chainsToCheck = chains || squadChains;

  if (chainsToCheck.length === 0) {
    rootLogger.error('No chains provided');
    process.exit(1);
  }

  rootLogger.info(chalk.blue.bold('🔍 Squads Proposal Status Monitor'));
  rootLogger.info(
    chalk.blue(
      `Checking squads proposals on chains: ${chainsToCheck.join(', ')}`,
    ),
  );

  const envConfig = getEnvironmentConfig(environment);
  const mpp = await envConfig.getMultiProtocolProvider();

  const pendingProposals = await getPendingProposalsForChains(
    chainsToCheck,
    mpp,
  );

  if (pendingProposals.length === 0) {
    rootLogger.info(chalk.green('No pending proposals found!'));
    process.exit(0);
  }

  logProposals(pendingProposals);

  // Filter for approved proposals that can be executed
  const executableProposals = pendingProposals.filter(
    (p) => p.status === SquadTxStatus.APPROVED,
  );

  if (executableProposals.length === 0) {
    rootLogger.info(chalk.green('No proposals ready to execute!'));
    process.exit(0);
  }

  const shouldExecute = await confirm({
    message: 'Execute proposals?',
    default: false,
  });

  if (!shouldExecute) {
    rootLogger.info(
      chalk.blue(
        `${executableProposals.length} proposal(s) available for execution`,
      ),
    );
    process.exit(0);
  }

  rootLogger.info(chalk.blueBright('Executing proposals...'));

  // Initialize Turnkey signer once for all executions
  rootLogger.info('Initializing Turnkey signer...');
  const turnkeySigner = await getTurnkeySealevelDeployerSigner(environment);

  // Create signers for each chain (keyed by chain name)
  const signersByChain: ChainMap<SvmMultiProtocolSignerAdapter> = {};
  const uniqueChains = Array.from(
    new Set(executableProposals.map((p) => p.chain)),
  );
  for (const chain of uniqueChains) {
    signersByChain[chain] = new SvmMultiProtocolSignerAdapter(
      chain,
      turnkeySigner,
      mpp,
    );
  }

  await executePendingTransactions(
    executableProposals,
    (p) => p.shortTxHash,
    (p) => p.chain,
    (p) => executeProposal(p.chain, mpp, p.nonce, signersByChain[p.chain]),
  );

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });

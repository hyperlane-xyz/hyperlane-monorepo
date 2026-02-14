import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  ChainMap,
  SquadTxStatus,
  SvmMultiProtocolSignerAdapter,
  executeProposal,
  getPendingProposalsForChains,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { executePendingTransactions } from '../../src/tx/utils.js';
import {
  getSquadsMultiProtocolProvider,
  getSquadsTurnkeySigner,
  logProposals,
  resolveSquadsChainsFromArgv,
  withSquadsChains,
} from './cli-helpers.js';

function getSignerForChain(
  signersByChain: ChainMap<SvmMultiProtocolSignerAdapter>,
  chain: string,
): SvmMultiProtocolSignerAdapter {
  const signer = signersByChain[chain];
  assert(
    signer,
    `Missing signer for chain ${chain} while executing Squads proposals`,
  );
  return signer;
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chains } = await withSquadsChains(yargs(process.argv.slice(2))).argv;
  const chainsToCheck = resolveSquadsChainsFromArgv(chains);

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

  const mpp = await getSquadsMultiProtocolProvider();

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
  const turnkeySigner = await getSquadsTurnkeySigner();

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
    (p) =>
      executeProposal(
        p.chain,
        mpp,
        p.nonce,
        getSignerForChain(signersByChain, p.chain),
      ),
  );

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });

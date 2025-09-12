import chalk from 'chalk';
import yargs, { Argv } from 'yargs';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { squadsConfigs } from '../../src/config/squads.js';
import { getSquadProposal } from '../../src/utils/squads.js';
import { withChain } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

function withTransactionIndex<T>(args: Argv<T>) {
  return args
    .describe('transactionIndex', 'Transaction index of the proposal to read')
    .number('transactionIndex')
    .demandOption('transactionIndex')
    .alias('t', 'transactionIndex');
}

function withVerbose<T>(args: Argv<T>) {
  return args
    .describe('verbose', 'Show verbose output including raw API data')
    .boolean('verbose')
    .default('verbose', false)
    .alias('v', 'verbose');
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chain, transactionIndex, verbose } = await withChain(
    withTransactionIndex(withVerbose(yargs(process.argv.slice(2)))),
  ).choices('chain', Object.keys(squadsConfigs)).argv;

  if (!squadsConfigs[chain as keyof typeof squadsConfigs]) {
    rootLogger.error(
      chalk.red.bold(`No squads config found for chain: ${chain}`),
    );
    rootLogger.info(
      chalk.gray('Available chains:'),
      Object.keys(squadsConfigs).join(', '),
    );
    process.exit(1);
  }

  rootLogger.info(chalk.blue.bold('🔍 Squads Proposal Reader'));
  rootLogger.info(
    chalk.blue(`Reading proposal ${transactionIndex} on chain: ${chain}`),
  );

  try {
    const envConfig = getEnvironmentConfig(environment);
    const mpp = await envConfig.getMultiProtocolProvider();

    rootLogger.info(chalk.gray('Fetching proposal data...'));

    const proposalData = await getSquadProposal(
      chain as any,
      mpp,
      transactionIndex,
    );

    if (!proposalData) {
      rootLogger.error(
        chalk.red.bold(`Proposal ${transactionIndex} not found on ${chain}`),
      );
      process.exit(1);
    }

    const { proposal, multisig, proposalPda } = proposalData;

    // Display basic proposal information
    rootLogger.info(chalk.green.bold('\n📋 Proposal Information:'));
    rootLogger.info(chalk.white(`  Chain: ${chain}`));
    rootLogger.info(chalk.white(`  Transaction Index: ${transactionIndex}`));
    rootLogger.info(chalk.white(`  Proposal PDA: ${proposalPda.toBase58()}`));
    rootLogger.info(
      chalk.white(`  Multisig PDA: ${proposal.multisig.toBase58()}`),
    );

    const staleTransactionIndex = Number(multisig.staleTransactionIndex);

    // Display proposal status
    rootLogger.info(chalk.green.bold('\n📊 Status Information:'));
    rootLogger.info(
      chalk.white(
        `  Status: ${transactionIndex < staleTransactionIndex ? 'Stale' : proposal.status.__kind}`,
      ),
    );
    if ('timestamp' in proposal.status && proposal.status.timestamp) {
      const timestamp = Number(proposal.status.timestamp);
      const date = new Date(timestamp * 1000);
      rootLogger.info(
        chalk.white(
          `  Timestamp: ${date.toISOString()} (${date.toLocaleString()})`,
        ),
      );
    }

    // Display voting information
    rootLogger.info(chalk.green.bold('\n🗳️  Voting Information:'));
    rootLogger.info(chalk.white(`  Approvals: ${proposal.approved.length}`));
    rootLogger.info(chalk.white(`  Rejections: ${proposal.rejected.length}`));
    rootLogger.info(
      chalk.white(`  Cancellations: ${proposal.cancelled.length}`),
    );
    rootLogger.info(chalk.white(`  Threshold: ${multisig.threshold}`));

    const status = proposal.status.__kind;
    const approvals = proposal.approved.length;
    const threshold = multisig.threshold;

    if (status === 'Active' && approvals >= threshold) {
      rootLogger.info(
        chalk.green(
          `  Status: Ready to execute (${approvals}/${threshold} approvals)`,
        ),
      );
    } else if (status === 'Active') {
      if (transactionIndex < staleTransactionIndex) {
        rootLogger.info(chalk.red(`  Status: Stale`));
      } else {
        rootLogger.info(
          chalk.yellow(
            `  Status: Pending (${approvals}/${threshold} approvals)`,
          ),
        );
      }
    } else {
      rootLogger.info(chalk.blue(`  Status: ${status}`));
    }

    // Display approvers
    if (proposal.approved.length > 0) {
      rootLogger.info(chalk.green.bold('\n✅ Approvers:'));
      proposal.approved.forEach((approver, index) => {
        rootLogger.info(chalk.white(`  ${index + 1}. ${approver.toBase58()}`));
      });
    }

    // Display rejectors
    if (proposal.rejected.length > 0) {
      rootLogger.info(chalk.red.bold('\n❌ Rejectors:'));
      proposal.rejected.forEach((rejector, index) => {
        rootLogger.info(chalk.white(`  ${index + 1}. ${rejector.toBase58()}`));
      });
    }

    // Display cancellers
    if (proposal.cancelled.length > 0) {
      rootLogger.info(chalk.gray.bold('\n🚫 Cancellers:'));
      proposal.cancelled.forEach((canceller, index) => {
        rootLogger.info(chalk.white(`  ${index + 1}. ${canceller.toBase58()}`));
      });
    }

    // Display transaction details
    rootLogger.info(chalk.green.bold('\n💼 Transaction Details:'));
    rootLogger.info(
      chalk.white(`  Transaction Index: ${proposal.transactionIndex}`),
    );
    rootLogger.info(chalk.white(`  Bump: ${proposal.bump}`));

    // Display vault information
    const vaultBalance = await mpp
      .getSolanaWeb3Provider(chain as any)
      .getBalance(
        new (await import('@solana/web3.js')).PublicKey(
          squadsConfigs[chain as keyof typeof squadsConfigs].vault,
        ),
      );
    const balanceFormatted = (vaultBalance / 1e9).toFixed(5);
    rootLogger.info(chalk.green.bold('\n💰 Vault Information:'));
    rootLogger.info(
      chalk.white(
        `  Vault Address: ${squadsConfigs[chain as keyof typeof squadsConfigs].vault}`,
      ),
    );
    rootLogger.info(chalk.white(`  Balance: ${balanceFormatted} SOL`));

    // Display multisig information
    rootLogger.info(chalk.green.bold('\n🏛️  Multisig Information:'));
    rootLogger.info(chalk.white(`  Threshold: ${multisig.threshold}`));
    rootLogger.info(chalk.white(`  Members: ${multisig.members.length}`));
    rootLogger.info(
      chalk.white(`  Current Transaction Index: ${multisig.transactionIndex}`),
    );
    rootLogger.info(chalk.white(`  Time Lock: ${multisig.timeLock}`));
    rootLogger.info(
      chalk.white(
        `  Stale Transaction Index: ${multisig.staleTransactionIndex}`,
      ),
    );
    rootLogger.info(
      chalk.white(`  Create Key: ${multisig.createKey.toBase58()}`),
    );
    rootLogger.info(
      chalk.white(`  Config Authority: ${multisig.configAuthority.toBase58()}`),
    );

    // Display members
    rootLogger.info(chalk.green.bold('\n👥 Multisig Members:'));
    multisig.members.forEach((member, index) => {
      rootLogger.info(chalk.white(`  ${index + 1}. ${member.key.toBase58()}`));
    });

    // Verbose output with raw data
    if (verbose) {
      rootLogger.info(chalk.green.bold('\n🔍 Raw Proposal Data:'));
      rootLogger.info(chalk.gray(JSON.stringify(proposal, null, 2)));

      rootLogger.info(chalk.green.bold('\n🔍 Raw Multisig Data:'));
      rootLogger.info(
        chalk.gray(
          stringifyObject({
            createKey: multisig.createKey.toBase58(),
            configAuthority: multisig.configAuthority.toBase58(),
            threshold: multisig.threshold,
            timeLock: multisig.timeLock,
            transactionIndex: multisig.transactionIndex,
            staleTransactionIndex: multisig.staleTransactionIndex,
            rentCollector: multisig.rentCollector,
            bump: multisig.bump,
            members: multisig.members.map((m) => ({
              key: m.key.toBase58(),
              permissions: m.permissions,
            })),
          }),
        ),
      );
    }

    rootLogger.info(
      chalk.green.bold('\n✅ Proposal data retrieved successfully!'),
    );
  } catch (error) {
    rootLogger.error(chalk.red.bold('❌ Error reading proposal:'));
    rootLogger.error(chalk.red(error));
    process.exit(1);
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });

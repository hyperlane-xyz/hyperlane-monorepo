import chalk from 'chalk';
import yargs, { Argv } from 'yargs';

import {
  SquadTxStatus,
  SquadsProposalStatus,
  getSquadTxStatus,
  parseSquadProposal,
  getSquadProposal,
  getSquadsKeys,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import {
  getSquadsMultiProtocolProvider,
  withRequiredSquadsChain,
  withTransactionIndex,
} from './cli-helpers.js';

function withVerbose<T>(args: Argv<T>) {
  return args
    .describe('verbose', 'Show verbose output including raw API data')
    .boolean('verbose')
    .default('verbose', false)
    .alias('v', 'verbose');
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chain, transactionIndex, verbose } = await withTransactionIndex(
    withVerbose(withRequiredSquadsChain(yargs(process.argv.slice(2)))),
  ).argv;

  rootLogger.info(chalk.blue.bold('🔍 Squads Proposal Reader'));
  rootLogger.info(
    chalk.blue(`Reading proposal ${transactionIndex} on chain: ${chain}`),
  );

  try {
    const squadsKeys = getSquadsKeys(chain);

    const mpp = await getSquadsMultiProtocolProvider();

    rootLogger.info(chalk.gray('Fetching proposal data...'));

    const proposalData = await getSquadProposal(chain, mpp, transactionIndex);

    if (!proposalData) {
      rootLogger.error(
        chalk.red.bold(`Proposal ${transactionIndex} not found on ${chain}`),
      );
      process.exit(1);
    }

    const { proposal, multisig, proposalPda } = proposalData;
    const parsedProposal = parseSquadProposal(proposal);

    // Display basic proposal information
    rootLogger.info(chalk.green.bold('\n📋 Proposal Information:'));
    rootLogger.info(chalk.white(`  Chain: ${chain}`));
    rootLogger.info(chalk.white(`  Transaction Index: ${transactionIndex}`));
    rootLogger.info(chalk.white(`  Proposal PDA: ${proposalPda.toBase58()}`));
    rootLogger.info(
      chalk.white(`  Multisig PDA: ${proposal.multisig.toBase58()}`),
    );

    // Coerce all numeric fields to consistent types for safe comparison
    const threshold = Number(multisig.threshold);
    const staleTransactionIndex = Number(multisig.staleTransactionIndex);
    const currentTransactionIndex = Number(multisig.transactionIndex);
    const timeLock = Number(multisig.timeLock);
    const { status, approvals, rejections, cancellations } = parsedProposal;
    const derivedStatus = getSquadTxStatus(
      status,
      approvals,
      threshold,
      transactionIndex,
      staleTransactionIndex,
    );

    // Display proposal status
    rootLogger.info(chalk.green.bold('\n📊 Status Information:'));
    rootLogger.info(chalk.white(`  On-chain Status: ${status}`));
    rootLogger.info(chalk.white(`  Derived Status: ${derivedStatus}`));
    if (
      'timestamp' in proposal.status &&
      typeof proposal.status.timestamp !== 'undefined'
    ) {
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
    rootLogger.info(chalk.white(`  Approvals: ${approvals}`));
    rootLogger.info(chalk.white(`  Rejections: ${rejections}`));
    rootLogger.info(chalk.white(`  Cancellations: ${cancellations}`));
    rootLogger.info(chalk.white(`  Threshold: ${threshold}`));

    if (derivedStatus === SquadTxStatus.APPROVED) {
      rootLogger.info(
        chalk.green(
          `  Status: Ready to execute (${approvals}/${threshold} approvals)`,
        ),
      );
    } else if (
      derivedStatus === SquadTxStatus.ACTIVE ||
      derivedStatus === SquadTxStatus.ONE_AWAY
    ) {
      rootLogger.info(
        chalk.yellow(`  Status: Pending (${approvals}/${threshold} approvals)`),
      );
    } else if (derivedStatus === SquadTxStatus.STALE) {
      rootLogger.info(chalk.red(`  Status: Stale`));
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
      chalk.white(`  Transaction Index: ${parsedProposal.transactionIndex}`),
    );
    rootLogger.info(chalk.white(`  Bump: ${Number(proposal.bump)}`));

    // Display vault information
    const { vault } = squadsKeys;
    const vaultBalance = await mpp
      .getSolanaWeb3Provider(chain)
      .getBalance(vault);
    const nativeToken = mpp.getChainMetadata(chain).nativeToken;
    const decimals = nativeToken?.decimals;
    if (typeof decimals !== 'number') {
      rootLogger.error(chalk.red.bold(`No decimals found for ${chain}`));
      process.exit(1);
    }
    const nativeTokenSymbol = nativeToken?.symbol;
    if (!nativeTokenSymbol) {
      rootLogger.error(
        chalk.red.bold(`No native token symbol found for ${chain}`),
      );
      process.exit(1);
    }
    const balanceFormatted = (vaultBalance / 10 ** decimals).toFixed(5);
    rootLogger.info(chalk.green.bold('\n💰 Vault Information:'));
    rootLogger.info(chalk.white(`  Vault Address: ${vault.toBase58()}`));
    rootLogger.info(
      chalk.white(`  Balance: ${balanceFormatted} ${nativeTokenSymbol}`),
    );

    // Display multisig information
    rootLogger.info(chalk.green.bold('\n🏛️  Multisig Information:'));
    rootLogger.info(chalk.white(`  Threshold: ${threshold}`));
    rootLogger.info(chalk.white(`  Members: ${multisig.members.length}`));
    rootLogger.info(
      chalk.white(`  Current Transaction Index: ${currentTransactionIndex}`),
    );
    rootLogger.info(chalk.white(`  Time Lock: ${timeLock}`));
    rootLogger.info(
      chalk.white(`  Stale Transaction Index: ${staleTransactionIndex}`),
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
      rootLogger.info(chalk.gray(stringifyObject(proposal)));

      rootLogger.info(chalk.green.bold('\n🔍 Raw Multisig Data:'));
      rootLogger.info(
        chalk.gray(
          stringifyObject({
            createKey: multisig.createKey.toBase58(),
            configAuthority: multisig.configAuthority.toBase58(),
            threshold: threshold,
            timeLock: timeLock,
            transactionIndex: currentTransactionIndex,
            staleTransactionIndex: staleTransactionIndex,
            rentCollector: multisig.rentCollector?.toBase58() || 'null',
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

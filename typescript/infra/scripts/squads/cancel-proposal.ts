import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  parseSquadMultisig,
  parseSquadProposal,
  SquadsProposalVoteError,
  SquadsProposalStatus,
  SvmMultiProtocolSignerAdapter,
  buildSquadsProposalCancellation,
  buildSquadsProposalRejection,
  deriveSquadsProposalModification,
  getSquadProposal,
  isTerminalSquadsProposalStatus,
  isStaleSquadsProposal,
  parseSquadsProposalVoteErrorFromError,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  ProtocolType,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  formatScriptError,
  getSquadsMultiProtocolProvider,
  getSquadsTurnkeySigner,
  withRequiredSquadsChain,
  withTransactionIndex,
} from './cli-helpers.js';

// CLI argument parsing
async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chain, transactionIndex } = await withTransactionIndex(
    withRequiredSquadsChain(yargs(process.argv.slice(2))),
  ).argv;

  const { chainsToSkip } = await import('../../src/config/chain.js');

  // Get multi-protocol provider
  const mpp = await getSquadsMultiProtocolProvider();
  const svmProvider = mpp.getSolanaWeb3Provider(chain);

  if (chainsToSkip.includes(chain)) {
    throw new Error(
      `Chain ${chain} is in the skip list and cannot be used for Squads operations.`,
    );
  }

  // Validate chain is Sealevel
  if (mpp.getProtocol(chain) !== ProtocolType.Sealevel) {
    throw new Error(
      `Chain ${chain} is not a Sealevel chain. This script only works with Solana/SVM chains.`,
    );
  }

  rootLogger.info(
    chalk.cyan(
      `\n=== Processing Squads Proposal ${transactionIndex} on ${chain} ===`,
    ),
  );

  const proposalData = await getSquadProposal(
    chain,
    mpp,
    transactionIndex,
    svmProvider,
  );
  if (!proposalData) {
    throw new Error(
      `Proposal ${transactionIndex} not found on ${chain}. Please check the transaction index.`,
    );
  }

  const { proposal, multisig } = proposalData;
  const parsedProposal = parseSquadProposal(proposal);
  const parsedMultisig = parseSquadMultisig(multisig, `${chain} multisig`);
  const { status, transactionIndex: proposalTransactionIndex } = parsedProposal;
  if (proposalTransactionIndex !== transactionIndex) {
    rootLogger.warn(
      chalk.yellow(
        `Requested transaction index ${transactionIndex} but proposal account reports index ${proposalTransactionIndex}. Using on-chain proposal index for this operation.`,
      ),
    );
  }
  rootLogger.info(chalk.gray(`Found proposal with status: ${status}`));

  // Check if proposal is stale
  const staleTransactionIndex = parsedMultisig.staleTransactionIndex;
  if (
    isStaleSquadsProposal(status, proposalTransactionIndex, staleTransactionIndex)
  ) {
    rootLogger.warn(
      chalk.yellow(
        `⚠️  Proposal ${proposalTransactionIndex} is stale (current stale index: ${staleTransactionIndex})`,
      ),
    );
    rootLogger.info(
      chalk.gray(
        'Stale proposals can still be rejected/cancelled but will not affect voting.',
      ),
    );
  }

  // Check if proposal is already executed, cancelled, or rejected
  if (isTerminalSquadsProposalStatus(status)) {
    if (status === SquadsProposalStatus.Executed) {
      throw new Error(
        `Proposal ${proposalTransactionIndex} has already been executed and cannot be modified.`,
      );
    }

    rootLogger.warn(
      chalk.yellow(
        `Proposal ${proposalTransactionIndex} is already ${status.toLowerCase()}.`,
      ),
    );
    return;
  }

  // Determine the appropriate action based on proposal status
  // - Active proposals: Use Reject (vote against)
  // - Approved proposals: Use Cancel (prevent execution)
  const proposalModification = deriveSquadsProposalModification(status);
  if (!proposalModification) {
    throw new Error(
      `Proposal ${proposalTransactionIndex} is ${status} and cannot be modified by this script. Expected ${SquadsProposalStatus.Active} or ${SquadsProposalStatus.Approved}.`,
    );
  }

  const { action, pastTenseAction: actionPastTense } = proposalModification;
  const isActive = action === 'reject';

  rootLogger.info(
    chalk.blue(
      `\nProposal is ${status}. Will use ${action.toUpperCase()} operation.`,
    ),
  );

  // Initialize Turnkey signer and create adapter
  rootLogger.info('Initializing Turnkey signer...');
  const turnkeySigner = await getSquadsTurnkeySigner();
  const signerAdapter = new SvmMultiProtocolSignerAdapter(
    chain,
    turnkeySigner,
    mpp,
  );
  rootLogger.info(`Member public key: ${await signerAdapter.address()}`);

  // Build the appropriate instruction
  const { instruction } = isActive
    ? await buildSquadsProposalRejection(
        chain,
        mpp,
        BigInt(proposalTransactionIndex),
        signerAdapter.publicKey(),
        svmProvider,
      )
    : await buildSquadsProposalCancellation(
        chain,
        mpp,
        BigInt(proposalTransactionIndex),
        signerAdapter.publicKey(),
        svmProvider,
      );

  // Confirm with user
  const shouldProceed = await confirm({
    message: `Are you sure you want to ${action} proposal ${proposalTransactionIndex} on ${chain}?`,
    default: false,
  });

  if (!shouldProceed) {
    rootLogger.info(chalk.yellow(`\n${action} operation aborted by user.`));
    return;
  }

  // Build, sign, send, and confirm transaction using the adapter
  rootLogger.info(
    chalk.gray(
      `Signing and submitting ${action} transaction with automatic confirmation...`,
    ),
  );

  try {
    const signature = await signerAdapter.buildAndSendTransaction([
      instruction,
    ]);

    rootLogger.info(
      chalk.green(
        `Proposal ${proposalTransactionIndex} has been ${actionPastTense} successfully.`,
      ),
    );

    const explorerUrl = mpp.getExplorerTxUrl(chain, { hash: signature });
    rootLogger.info(chalk.gray(`Transaction: ${explorerUrl}`));
  } catch (error: unknown) {
    const parsedError = parseSquadsProposalVoteErrorFromError(error);
    switch (parsedError) {
      case SquadsProposalVoteError.AlreadyRejected:
        rootLogger.warn(
          chalk.yellow(
            `Member has already rejected proposal ${proposalTransactionIndex}.`,
          ),
        );
        return;
      case SquadsProposalVoteError.AlreadyApproved:
        rootLogger.warn(
          chalk.yellow(
            `Member has already approved proposal ${proposalTransactionIndex}.`,
          ),
        );
        return;
      case SquadsProposalVoteError.AlreadyCancelled:
        rootLogger.warn(
          chalk.yellow(
            `Proposal ${proposalTransactionIndex} has already been cancelled.`,
          ),
        );
        return;
    }

    // Re-throw if not a handled error
    throw error;
  }
}

main().catch((err) => {
  rootLogger.error(
    `Error processing Squads proposal: ${formatScriptError(err)}`,
  );
  process.exit(1);
});

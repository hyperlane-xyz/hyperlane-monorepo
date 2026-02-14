import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  SquadsProposalVoteError,
  SquadsProposalStatus,
  SvmMultiProtocolSignerAdapter,
  buildSquadsProposalCancellation,
  buildSquadsProposalRejection,
  getSquadProposal,
  parseSquadsProposalVoteErrorFromError,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { withSquadsChain, withTransactionIndex } from './cli-helpers.js';

const environment = 'mainnet3';

// CLI argument parsing
async function main() {
  const { chain, transactionIndex } = await withTransactionIndex(
    withSquadsChain(yargs(process.argv.slice(2))),
  ).demandOption('chain').argv;

  const { getEnvironmentConfig } = await import('../core-utils.js');
  const { chainsToSkip } = await import('../../src/config/chain.js');
  const { getTurnkeySealevelDeployerSigner } =
    await import('../../src/utils/turnkey.js');

  // Get multi-protocol provider
  const envConfig = getEnvironmentConfig(environment);
  const mpp = await envConfig.getMultiProtocolProvider();

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

  const proposalData = await getSquadProposal(chain, mpp, transactionIndex);
  if (!proposalData) {
    throw new Error(
      `Proposal ${transactionIndex} not found on ${chain}. Please check the transaction index.`,
    );
  }

  const { proposal, multisig } = proposalData;
  const status = proposal.status.__kind;
  rootLogger.info(chalk.gray(`Found proposal with status: ${status}`));

  // Check if proposal is stale
  const staleTransactionIndex = Number(multisig.staleTransactionIndex);
  if (transactionIndex < staleTransactionIndex) {
    rootLogger.warn(
      chalk.yellow(
        `⚠️  Proposal ${transactionIndex} is stale (current stale index: ${staleTransactionIndex})`,
      ),
    );
    rootLogger.info(
      chalk.gray(
        'Stale proposals can still be rejected/cancelled but will not affect voting.',
      ),
    );
  }

  // Check if proposal is already executed, cancelled, or rejected
  if (status === SquadsProposalStatus.Executed) {
    throw new Error(
      `Proposal ${transactionIndex} has already been executed and cannot be modified.`,
    );
  }

  if (status === SquadsProposalStatus.Cancelled) {
    rootLogger.warn(
      chalk.yellow(`Proposal ${transactionIndex} is already cancelled.`),
    );
    return;
  }

  if (status === SquadsProposalStatus.Rejected) {
    rootLogger.warn(
      chalk.yellow(`Proposal ${transactionIndex} is already rejected.`),
    );
    return;
  }

  // Determine the appropriate action based on proposal status
  // - Active proposals: Use Reject (vote against)
  // - Approved proposals: Use Cancel (prevent execution)
  const isActive = status === SquadsProposalStatus.Active;
  const action = isActive ? 'reject' : 'cancel';
  const actionPastTense = isActive ? 'rejected' : 'cancelled';

  rootLogger.info(
    chalk.blue(
      `\nProposal is ${status}. Will use ${action.toUpperCase()} operation.`,
    ),
  );

  // Initialize Turnkey signer and create adapter
  rootLogger.info('Initializing Turnkey signer...');
  const turnkeySigner = await getTurnkeySealevelDeployerSigner(environment);
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
        BigInt(transactionIndex),
        signerAdapter.publicKey(),
      )
    : await buildSquadsProposalCancellation(
        chain,
        mpp,
        BigInt(transactionIndex),
        signerAdapter.publicKey(),
      );

  // Confirm with user
  const shouldProceed = await confirm({
    message: `Are you sure you want to ${action} proposal ${transactionIndex} on ${chain}?`,
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
        `Proposal ${transactionIndex} has been ${actionPastTense} successfully.`,
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
            `Member has already rejected proposal ${transactionIndex}.`,
          ),
        );
        return;
      case SquadsProposalVoteError.AlreadyApproved:
        rootLogger.warn(
          chalk.yellow(
            `Member has already approved proposal ${transactionIndex}.`,
          ),
        );
        return;
      case SquadsProposalVoteError.AlreadyCancelled:
        rootLogger.warn(
          chalk.yellow(
            `Proposal ${transactionIndex} has already been cancelled.`,
          ),
        );
        return;
    }

    // Re-throw if not a handled error
    throw error;
  }
}

main().catch((err) => {
  rootLogger.error('Error processing Squads proposal:', err);
  process.exit(1);
});

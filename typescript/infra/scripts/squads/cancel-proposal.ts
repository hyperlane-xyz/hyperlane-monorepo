import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import { SvmMultiProtocolSignerAdapter } from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { chainsToSkip } from '../../src/config/chain.js';
import {
  SquadsProposalStatus,
  buildSquadsProposalCancellation,
  buildSquadsProposalRejection,
  getSquadProposal,
  withTransactionIndex,
} from '../../src/utils/squads.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import { chainIsProtocol } from '../../src/utils/utils.js';
import { withChain } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

// CLI argument parsing
async function main() {
  const { chain, transactionIndex } = await withTransactionIndex(
    withChain(yargs(process.argv.slice(2))),
  ).demandOption('chain').argv;

  // Validate chain is Sealevel
  if (!chainIsProtocol(chain, ProtocolType.Sealevel)) {
    throw new Error(
      `Chain ${chain} is not a Sealevel chain. This script only works with Solana/SVM chains.`,
    );
  }

  if (chainsToSkip.includes(chain)) {
    throw new Error(
      `Chain ${chain} is in the skip list and cannot be used for Squads operations.`,
    );
  }

  // Get multi-protocol provider
  const envConfig = getEnvironmentConfig(environment);
  const mpp = await envConfig.getMultiProtocolProvider();

  rootLogger.info(
    chalk.cyan(
      `\n=== Processing Squads Proposal ${transactionIndex} on ${chain} ===`,
    ),
  );

  // Fetch the proposal to verify it exists
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
  } catch (error: any) {
    // Check for specific Squads error codes from squads-v4/programs/squads_multisig_program/src/errors.rs
    if (error?.transactionLogs) {
      const logs = error.transactionLogs.join('\n');

      // Error 6011 (0x177b): AlreadyRejected
      if (logs.includes('AlreadyRejected') || logs.includes('0x177b')) {
        rootLogger.warn(
          chalk.yellow(
            `Member has already rejected proposal ${transactionIndex}.`,
          ),
        );
        return;
      }

      // Error 6010 (0x177a): AlreadyApproved
      if (logs.includes('AlreadyApproved') || logs.includes('0x177a')) {
        rootLogger.warn(
          chalk.yellow(
            `Member has already approved proposal ${transactionIndex}.`,
          ),
        );
        return;
      }

      // Error 6012 (0x177c): AlreadyCancelled
      if (logs.includes('AlreadyCancelled') || logs.includes('0x177c')) {
        rootLogger.warn(
          chalk.yellow(
            `Proposal ${transactionIndex} has already been cancelled.`,
          ),
        );
        return;
      }
    }

    // Re-throw if not a handled error
    throw error;
  }
}

main().catch((err) => {
  rootLogger.error('Error processing Squads proposal:', err);
  process.exit(1);
});

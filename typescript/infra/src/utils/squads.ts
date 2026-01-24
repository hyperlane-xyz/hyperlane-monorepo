import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import {
  accounts,
  getProposalPda,
  getTransactionPda,
  instructions,
} from '@sqds/multisig';
import chalk from 'chalk';
import { Argv } from 'yargs';

import {
  ChainName,
  MultiProtocolProvider,
  SQUADS_ACCOUNT_DISCRIMINATORS,
  SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  SQUADS_DISCRIMINATOR_SIZE,
  SQUADS_INSTRUCTION_DISCRIMINATORS,
  SquadsAccountType,
  SquadsInstructionName,
  SquadsInstructionType,
  SquadsPermission,
  SquadsProposalStatus,
  SvmMultiProtocolSignerAdapter,
  decodePermissions,
  isConfigTransaction,
  isVaultTransaction,
  parseSquadProposal,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getSquadsKeys, squadsConfigs } from '../config/squads.js';

import { logTable } from './log.js';

// ============================================================================
// Squads V4 Constants (re-exported from SDK)
// ============================================================================

// Re-export pure parsing types and constants from SDK
export {
  SQUADS_DISCRIMINATOR_SIZE,
  SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  SquadsProposalStatus,
  SquadsAccountType,
  SquadsInstructionType,
  SquadsInstructionName,
  SQUADS_ACCOUNT_DISCRIMINATORS,
  SQUADS_INSTRUCTION_DISCRIMINATORS,
  SquadsPermission,
  decodePermissions,
  parseSquadProposal,
  isVaultTransaction,
  isConfigTransaction,
} from '@hyperlane-xyz/sdk';

// Infra-specific types
export type SquadProposalStatus = {
  chain: string;
  nonce: number;
  status: string;
  shortTxHash: string;
  fullTxHash: string;
  approvals: number;
  rejections: number;
  cancellations: number;
  threshold: number;
  balance: string;
  submissionDate: string;
};

export enum SquadTxStatus {
  DRAFT = '📝',
  ACTIVE = '🟡',
  ONE_AWAY = '🔵',
  APPROVED = '🟢',
  REJECTED = '🔴',
  EXECUTING = '⚡',
  EXECUTED = '✅',
  CANCELLED = '❌',
  STALE = '💩',
}

export async function getSquadAndProvider(
  chain: ChainName,
  mpp: MultiProtocolProvider,
) {
  const svmProvider = mpp.getSolanaWeb3Provider(chain);
  const { multisigPda, programId } = getSquadsKeys(chain);

  return { svmProvider, multisigPda, programId };
}

export async function getSquadProposal(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
): Promise<
  | {
      proposal: accounts.Proposal;
      multisig: accounts.Multisig;
      proposalPda: PublicKey;
    }
  | undefined
> {
  try {
    const { svmProvider, multisigPda, programId } = await getSquadAndProvider(
      chain,
      mpp,
    );

    // Fetch the deserialized Multisig account
    const multisig = await accounts.Multisig.fromAccountAddress(
      // @ts-ignore
      svmProvider,
      multisigPda,
    );

    // Get the proposal PDA
    const [proposalPda] = getProposalPda({
      multisigPda,
      transactionIndex: BigInt(transactionIndex),
      programId,
    });

    // Fetch the proposal account
    const proposal = await accounts.Proposal.fromAccountAddress(
      // @ts-ignore
      svmProvider,
      proposalPda,
    );

    return { proposal, multisig, proposalPda };
  } catch (error) {
    rootLogger.warn(
      chalk.yellow(
        `Failed to fetch proposal ${transactionIndex} on ${chain}: ${error}`,
      ),
    );
    return undefined;
  }
}

export async function getPendingProposalsForChains(
  chains: string[],
  mpp: MultiProtocolProvider,
): Promise<SquadProposalStatus[]> {
  const proposals: SquadProposalStatus[] = [];

  await Promise.all(
    chains.map(async (chain) => {
      if (!squadsConfigs[chain]) {
        rootLogger.error(chalk.red.bold(`No squads config found for ${chain}`));
        return;
      }

      try {
        const { svmProvider, multisigPda } = await getSquadAndProvider(
          chain,
          mpp,
        );

        // Fetch the deserialized Multisig account
        const multisig = await accounts.Multisig.fromAccountAddress(
          // @ts-ignore
          svmProvider,
          multisigPda,
        );

        // Coerce all numeric fields to consistent types for safe comparison
        const threshold = Number(multisig.threshold);
        const currentTransactionIndex = Number(multisig.transactionIndex);
        const staleTransactionIndex = Number(multisig.staleTransactionIndex);

        // Get vault balance using getSquadsKeys for consistent PublicKey construction
        const { vault } = getSquadsKeys(chain);
        const vaultBalance = await svmProvider.getBalance(vault);
        const decimals = mpp.getChainMetadata(chain).nativeToken?.decimals;
        if (!decimals) {
          rootLogger.error(chalk.red.bold(`No decimals found for ${chain}`));
          return;
        }
        // Convert lamports to SOL
        const balanceFormatted = (vaultBalance / 10 ** decimals).toFixed(5);

        rootLogger.info(
          chalk.gray.italic(
            `Fetching proposals for squads ${multisigPda.toBase58()} on ${chain}`,
          ),
        );

        // Check the last few transaction indices for pending proposals
        const maxIndexToCheck = Math.max(1, currentTransactionIndex - 10);

        for (let i = currentTransactionIndex; i >= maxIndexToCheck; i--) {
          try {
            const proposalData = await getSquadProposal(chain, mpp, i);

            if (!proposalData) continue;

            const { proposal, proposalPda } = proposalData;

            // Only include non-executed proposals
            if (proposal.status.__kind === SquadsProposalStatus.Executed) {
              continue;
            }

            // Skip stale transactions
            if (i < staleTransactionIndex) continue;

            const approvals = proposal.approved.length;
            const rejections = proposal.rejected.length;
            const cancellations = proposal.cancelled.length;

            const status = getSquadTxStatus(
              proposal.status.__kind,
              approvals,
              threshold,
              i,
              staleTransactionIndex,
            );

            // Get submission date from status timestamp if available
            let submissionDate = 'Executing';
            if (
              proposal.status.__kind !== SquadsProposalStatus.Executing &&
              proposal.status.timestamp
            ) {
              const timestamp = Number(proposal.status.timestamp);
              submissionDate = new Date(timestamp * 1000).toDateString();
            }

            // Get the VaultTransaction PDA (this is what contains the actual transaction instructions)
            const { programId } = getSquadsKeys(chain);
            const [transactionPda] = getTransactionPda({
              multisigPda,
              index: BigInt(i),
              programId,
            });
            const txHash = transactionPda.toBase58();

            proposals.push({
              chain,
              nonce: i,
              status,
              shortTxHash: `${txHash.slice(0, 6)}...${txHash.slice(-4)}`,
              fullTxHash: txHash,
              approvals,
              rejections,
              cancellations,
              threshold,
              balance: `${balanceFormatted} SOL`,
              submissionDate,
            });
          } catch (error) {
            // Skip if proposal doesn't exist or other error
            continue;
          }
        }
      } catch (error) {
        rootLogger.warn(
          chalk.yellow(
            `Skipping chain ${chain} as there was an error getting the squads data: ${error}`,
          ),
        );
        return;
      }
    }),
  );

  return proposals.sort(
    (a, b) => a.chain.localeCompare(b.chain) || a.nonce - b.nonce,
  );
}

export function getSquadTxStatus(
  statusKind: SquadsProposalStatus,
  approvals: number,
  threshold: number,
  transactionIndex: number,
  staleTransactionIndex: number,
): string {
  // Check if transaction is stale before checking other statuses
  // Only return stale if it hasn't been executed
  if (
    transactionIndex < staleTransactionIndex &&
    statusKind !== SquadsProposalStatus.Executed
  ) {
    return SquadTxStatus.STALE;
  }

  switch (statusKind) {
    case SquadsProposalStatus.Draft:
      return SquadTxStatus.DRAFT;
    case SquadsProposalStatus.Active:
      return approvals >= threshold
        ? SquadTxStatus.APPROVED
        : threshold - approvals === 1
          ? SquadTxStatus.ONE_AWAY
          : SquadTxStatus.ACTIVE;
    case SquadsProposalStatus.Rejected:
      return SquadTxStatus.REJECTED;
    case SquadsProposalStatus.Approved:
      return SquadTxStatus.APPROVED;
    case SquadsProposalStatus.Executing:
      return SquadTxStatus.EXECUTING;
    case SquadsProposalStatus.Executed:
      return SquadTxStatus.EXECUTED;
    case SquadsProposalStatus.Cancelled:
      return SquadTxStatus.CANCELLED;
    default:
      return '❓';
  }
}

export function logProposals(pendingProposals: SquadProposalStatus[]) {
  // Display pending proposals table
  rootLogger.info(
    chalk.cyan.bold(`Found ${pendingProposals.length} pending proposal(s):`),
  );
  // Format approvals/threshold for display
  const formattedProposals = pendingProposals.map((p) => ({
    ...p,
    approvals: `${p.approvals}/${p.threshold}`,
  }));

  logTable(formattedProposals, [
    'chain',
    'nonce',
    'submissionDate',
    'fullTxHash',
    'approvals',
    'status',
    'balance',
  ]);
}

// ============================================================================
// Squads Proposal Helpers
// ============================================================================

/**
 * Get the next available transaction index from the multisig
 */
async function getNextSquadsTransactionIndex(
  chain: ChainName,
  mpp: MultiProtocolProvider,
): Promise<bigint> {
  const { svmProvider, multisigPda } = await getSquadAndProvider(chain, mpp);
  const { programId } = getSquadsKeys(chain);

  rootLogger.debug(
    chalk.gray(`Fetching multisig account from: ${multisigPda.toBase58()}`),
  );

  const multisig = await accounts.Multisig.fromAccountAddress(
    // @ts-ignore - SDK types are slightly incompatible but work at runtime
    svmProvider,
    multisigPda,
  );

  // IMPORTANT: transactionIndex stores the index of the LAST transaction.
  // The NEXT transaction should use transactionIndex + 1.
  // This matches the on-chain derivation in vault_transaction_create.rs:
  // &multisig.transaction_index.checked_add(1).unwrap().to_le_bytes()
  const currentIndex = BigInt(multisig.transactionIndex.toString());
  const nextIndex = currentIndex + 1n;

  rootLogger.debug(
    chalk.gray(`Multisig transactionIndex field: ${currentIndex}`),
  );
  rootLogger.debug(chalk.gray(`Next transaction will use index: ${nextIndex}`));
  rootLogger.debug(
    chalk.gray(
      `Multisig staleTransactionIndex: ${multisig.staleTransactionIndex.toString()}`,
    ),
  );
  rootLogger.debug(
    chalk.gray(`Multisig threshold: ${multisig.threshold.toString()}`),
  );

  // Verify the account is owned by the correct program
  const accountInfo = await svmProvider.getAccountInfo(multisigPda);
  if (accountInfo) {
    rootLogger.debug(
      chalk.gray(`Multisig account owner: ${accountInfo.owner.toBase58()}`),
    );
    rootLogger.debug(
      chalk.gray(`Expected program ID: ${programId.toBase58()}`),
    );
    if (!accountInfo.owner.equals(programId)) {
      rootLogger.warn(
        chalk.yellow(
          `WARNING: Multisig account owner (${accountInfo.owner.toBase58()}) does not match expected program ID (${programId.toBase58()})`,
        ),
      );
    }
  }

  return nextIndex;
}

/**
 * Build a TransactionMessage for vault execution
 * This message will be executed by the vault after multisig approval
 */
function buildVaultTransactionMessage(
  vaultPda: PublicKey,
  ixs: TransactionInstruction[],
  recentBlockhash: string,
): TransactionMessage {
  return new TransactionMessage({
    payerKey: vaultPda, // Important: vault is the payer for inner transaction
    recentBlockhash,
    instructions: ixs,
  });
}

/**
 * Create vaultTransactionCreate instruction
 */
function createVaultTransactionInstruction(
  multisigPda: PublicKey,
  transactionIndex: bigint,
  creator: PublicKey,
  vaultIndex: number,
  transactionMessage: TransactionMessage,
  programId: PublicKey,
  memo?: string,
): TransactionInstruction {
  return instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex,
    creator,
    rentPayer: creator,
    vaultIndex,
    ephemeralSigners: 0,
    transactionMessage,
    memo: memo || 'Hyperlane Multisig ISM Update',
    programId,
  });
}

/**
 * Create proposalCreate instruction
 */
function createProposalInstruction(
  multisigPda: PublicKey,
  transactionIndex: bigint,
  creator: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return instructions.proposalCreate({
    multisigPda,
    transactionIndex,
    creator,
    rentPayer: creator,
    programId,
  });
}

/**
 * Create proposalCancel instruction
 */
function createProposalCancelInstruction(
  multisigPda: PublicKey,
  transactionIndex: bigint,
  member: PublicKey,
  programId: PublicKey,
): TransactionInstruction {
  return instructions.proposalCancel({
    multisigPda,
    transactionIndex,
    member,
    programId,
  });
}

/**
 * Build vault transaction proposal instructions
 * This creates both the vault transaction and the proposal in one transaction
 *
 * @param chain - The chain to create the proposal on
 * @param mpp - Multi-protocol provider
 * @param ixs - The instructions to execute via the vault after approval
 * @param creator - The public key of the proposal creator (must be a multisig member)
 * @param memo - Optional memo for the vault transaction
 * @returns Instructions to create the proposal, transaction index
 */
export async function buildSquadsVaultTransactionProposal(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  ixs: TransactionInstruction[],
  creator: PublicKey,
  memo?: string,
): Promise<{
  instructions: TransactionInstruction[];
  transactionIndex: bigint;
}> {
  const { svmProvider, multisigPda } = await getSquadAndProvider(chain, mpp);
  const { vault, programId } = getSquadsKeys(chain);

  rootLogger.info(
    chalk.cyan(`\n=== Debug: Building Squads Proposal for ${chain} ===`),
  );
  rootLogger.info(chalk.gray(`  Program ID: ${programId.toBase58()}`));
  rootLogger.info(chalk.gray(`  Multisig PDA: ${multisigPda.toBase58()}`));
  rootLogger.info(chalk.gray(`  Vault: ${vault.toBase58()}`));
  rootLogger.info(chalk.gray(`  Creator: ${creator.toBase58()}`));

  // 1. Get next transaction index
  const transactionIndex = await getNextSquadsTransactionIndex(chain, mpp);
  rootLogger.info(chalk.gray(`  Transaction Index: ${transactionIndex}`));

  // Debug: Check what transaction PDA we expect
  const [expectedTxPda] = getTransactionPda({
    multisigPda,
    index: transactionIndex,
    programId,
  });
  rootLogger.info(
    chalk.yellow(`  Expected Transaction PDA: ${expectedTxPda.toBase58()}`),
  );

  // 2. Get recent blockhash for inner transaction
  const { blockhash } = await svmProvider.getLatestBlockhash();

  // 3. Build vault transaction message (inner transaction)
  const transactionMessage = buildVaultTransactionMessage(
    vault,
    ixs,
    blockhash,
  );

  // 4. Create proposal instructions (outer transaction)
  const vaultTxIx = createVaultTransactionInstruction(
    multisigPda,
    transactionIndex,
    creator,
    0, // vaultIndex
    transactionMessage,
    programId,
    memo,
  );

  const proposalIx = createProposalInstruction(
    multisigPda,
    transactionIndex,
    creator,
    programId,
  );

  return {
    instructions: [vaultTxIx, proposalIx],
    transactionIndex,
  };
}

/**
 * Build proposal rejection instruction
 * Reject is used to vote against Active proposals
 *
 * @param chain - The chain to reject the proposal on
 * @param mpp - Multi-protocol provider
 * @param transactionIndex - The transaction index of the proposal to reject
 * @param member - The public key of the member rejecting the proposal
 * @returns Instruction to reject the proposal
 */
export async function buildSquadsProposalRejection(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: bigint,
  member: PublicKey,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const { multisigPda, programId } = await getSquadAndProvider(chain, mpp);

  const rejectIx = instructions.proposalReject({
    multisigPda,
    transactionIndex,
    member,
    programId,
  });

  return {
    instruction: rejectIx,
  };
}

/**
 * Build proposal cancellation instruction
 * Cancel can ONLY be used on Approved proposals (to prevent execution before timelock expires)
 *
 * @param chain - The chain to cancel the proposal on
 * @param mpp - Multi-protocol provider
 * @param transactionIndex - The transaction index of the proposal to cancel
 * @param member - The public key of the member canceling the proposal
 * @returns Instruction to cancel the proposal
 */
export async function buildSquadsProposalCancellation(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: bigint,
  member: PublicKey,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const { multisigPda, programId } = await getSquadAndProvider(chain, mpp);

  const cancelIx = createProposalCancelInstruction(
    multisigPda,
    transactionIndex,
    member,
    programId,
  );

  return {
    instruction: cancelIx,
  };
}

/**
 * Submit a Squads proposal with an SVM signer adapter
 *
 * @param chain - The chain to submit the proposal on
 * @param vaultInstructions - The instructions to execute via the vault after approval
 * @param mpp - Multi-protocol provider
 * @param signerAdapter - Pre-configured SVM signer adapter for signing and submitting transactions
 */
export async function submitProposalToSquads(
  chain: ChainName,
  vaultInstructions: TransactionInstruction[],
  mpp: MultiProtocolProvider,
  signerAdapter: SvmMultiProtocolSignerAdapter,
  memo?: string,
): Promise<void> {
  rootLogger.info(chalk.cyan('\n=== Submitting to Squads ==='));

  try {
    // Get creator public key from adapter
    const creatorPublicKey = signerAdapter.publicKey();

    // Build Squads proposal instructions
    const { instructions: proposalInstructions, transactionIndex } =
      await buildSquadsVaultTransactionProposal(
        chain,
        mpp,
        vaultInstructions,
        creatorPublicKey,
        memo,
      );

    // Build, sign, send, and confirm transaction using the adapter
    rootLogger.info(
      chalk.gray(
        'Submitting proposal creation transaction with automatic confirmation...',
      ),
    );
    const createSignature =
      await signerAdapter.buildAndSendTransaction(proposalInstructions);

    rootLogger.info(chalk.green(`Proposal created: ${createSignature}`));
    rootLogger.info(chalk.gray(`   Transaction index: ${transactionIndex}`));

    // Approve the proposal as the proposer
    rootLogger.info(chalk.gray('Approving proposal as proposer...'));
    const { multisigPda, programId } = getSquadsKeys(chain);
    const approveIx = instructions.proposalApprove({
      multisigPda,
      transactionIndex,
      member: creatorPublicKey,
      programId,
    });

    const approveSignature = await signerAdapter.buildAndSendTransaction([
      approveIx,
    ]);
    rootLogger.info(chalk.green(`Proposal approved: ${approveSignature}`));
    rootLogger.info(
      chalk.green(
        'Proposal created and approved by proposer. Other multisig members can now approve.',
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(`Failed to submit proposal to Squads: ${error}`),
    );
    throw error;
  }
}

/**
 * Determine if a transaction is a VaultTransaction or ConfigTransaction
 *
 * @param chain - The chain to check the transaction on
 * @param mpp - Multi-protocol provider
 * @param transactionIndex - The transaction index to check
 * @returns SquadsAccountType.VAULT or SquadsAccountType.CONFIG
 * @throws Error if transaction account not found or unknown transaction type
 */
export async function getTransactionType(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
): Promise<SquadsAccountType> {
  const { svmProvider, multisigPda, programId } = await getSquadAndProvider(
    chain,
    mpp,
  );

  const [transactionPda] = getTransactionPda({
    multisigPda,
    index: BigInt(transactionIndex),
    programId,
  });

  const accountInfo = await svmProvider.getAccountInfo(transactionPda);
  if (!accountInfo) {
    throw new Error(
      `Transaction account not found at ${transactionPda.toBase58()}`,
    );
  }

  if (isVaultTransaction(accountInfo.data)) {
    return SquadsAccountType.VAULT;
  } else if (isConfigTransaction(accountInfo.data)) {
    return SquadsAccountType.CONFIG;
  } else {
    const discriminator = accountInfo.data.subarray(
      0,
      SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
    );
    throw new Error(
      `Unknown transaction type with discriminator: [${Array.from(discriminator).join(', ')}]. Expected VaultTransaction or ConfigTransaction.`,
    );
  }
}

/**
 * Execute an approved Squads proposal
 *
 * @param chain - The chain to execute the proposal on
 * @param mpp - Multi-protocol provider
 * @param transactionIndex - The transaction index of the proposal to execute
 * @param signerAdapter - Pre-configured SVM signer adapter for signing and submitting transactions
 */
export async function executeProposal(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
  signerAdapter: SvmMultiProtocolSignerAdapter,
): Promise<void> {
  const { svmProvider, multisigPda, programId } = await getSquadAndProvider(
    chain,
    mpp,
  );

  // Fetch the proposal to verify it's approved
  const proposalData = await getSquadProposal(chain, mpp, transactionIndex);
  if (!proposalData) {
    throw new Error(`Failed to fetch proposal ${transactionIndex} on ${chain}`);
  }

  const { proposal } = proposalData;

  // Verify the proposal is in Approved status
  if (proposal.status.__kind !== SquadsProposalStatus.Approved) {
    throw new Error(
      `Proposal ${transactionIndex} on ${chain} is not approved (status: ${proposal.status.__kind})`,
    );
  }

  // Determine transaction type
  const txType = await getTransactionType(chain, mpp, transactionIndex);
  rootLogger.info(
    chalk.cyan(
      `Executing ${txType} proposal ${transactionIndex} on ${chain}...`,
    ),
  );

  // Get executor public key
  const executorPublicKey = signerAdapter.publicKey();

  try {
    let instruction: TransactionInstruction;

    if (txType === SquadsAccountType.VAULT) {
      // Build the vault transaction execution instruction
      const { instruction: vaultInstruction, lookupTableAccounts } =
        await instructions.vaultTransactionExecute({
          connection: svmProvider,
          multisigPda,
          transactionIndex: BigInt(transactionIndex),
          member: executorPublicKey,
          programId,
        });

      // Error if lookup tables are present - some chains don't support versioned transactions
      if (lookupTableAccounts.length > 0) {
        throw new Error(
          `Transaction requires ${lookupTableAccounts.length} address lookup table(s). ` +
            `Versioned transactions are not supported on ${chain}. ` +
            `This transaction may have too many accounts to fit in a legacy transaction.`,
        );
      }

      instruction = vaultInstruction;
    } else {
      // Build the config transaction execution instruction
      instruction = instructions.configTransactionExecute({
        multisigPda,
        transactionIndex: BigInt(transactionIndex),
        member: executorPublicKey,
        programId,
      });
    }

    // Execute the transaction using legacy transaction format
    const signature = await signerAdapter.buildAndSendTransaction([
      instruction,
    ]);

    rootLogger.info(
      chalk.green.bold(
        `Executed proposal ${transactionIndex} on ${chain}: ${signature}`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(`Error executing proposal ${transactionIndex} on ${chain}:`),
    );
    console.error(error);
    throw error;
  }
}

// ============================================================================
// CLI Utilities
// ============================================================================

/**
 * Yargs helper to add transactionIndex argument to CLI scripts
 */
export function withTransactionIndex<T>(args: Argv<T>) {
  return args
    .describe('transactionIndex', 'Transaction index of the proposal')
    .number('transactionIndex')
    .demandOption('transactionIndex')
    .alias('t', 'transactionIndex');
}

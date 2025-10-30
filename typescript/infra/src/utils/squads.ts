import { PublicKey } from '@solana/web3.js';
import { accounts, getProposalPda, getTransactionPda } from '@sqds/multisig';
import chalk from 'chalk';

import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getSquadsKeys, squadsConfigs } from '../config/squads.js';

import { logTable } from './log.js';

// ============================================================================
// Squads V4 Constants
// ============================================================================

/**
 * Squads V4 instruction discriminator size (8-byte Anchor discriminator)
 * First 8 bytes of SHA256 hash of "global:instruction_name"
 */
export const SQUADS_DISCRIMINATOR_SIZE = 8;

/**
 * Squads V4 account discriminator size (8-byte Anchor discriminator)
 * First 8 bytes of SHA256 hash of "account:account_name"
 */
export const SQUADS_ACCOUNT_DISCRIMINATOR_SIZE = 8;

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
            if (proposal.status.__kind === 'Executed') continue;

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
              proposal.status.__kind !== 'Executing' &&
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
  statusKind: accounts.Proposal['status']['__kind'],
  approvals: number,
  threshold: number,
  transactionIndex: number,
  staleTransactionIndex: number,
): string {
  // Check if transaction is stale before checking other statuses
  // Only return stale if it hasn't been executed
  if (transactionIndex < staleTransactionIndex && statusKind !== 'Executed') {
    return SquadTxStatus.STALE;
  }

  switch (statusKind) {
    case 'Draft':
      return SquadTxStatus.DRAFT;
    case 'Active':
      return approvals >= threshold
        ? SquadTxStatus.APPROVED
        : threshold - approvals === 1
          ? SquadTxStatus.ONE_AWAY
          : SquadTxStatus.ACTIVE;
    case 'Rejected':
      return SquadTxStatus.REJECTED;
    case 'Approved':
      return SquadTxStatus.APPROVED;
    case 'Executing':
      return SquadTxStatus.EXECUTING;
    case 'Executed':
      return SquadTxStatus.EXECUTED;
    case 'Cancelled':
      return SquadTxStatus.CANCELLED;
    default:
      return '❓';
  }
}

export function parseSquadProposal(proposal: accounts.Proposal) {
  // This would parse the proposal data similar to parseSafeTx
  // For now, return basic info
  return {
    status: proposal.status.__kind,
    approvals: proposal.approved.length,
    rejections: proposal.rejected.length,
    cancellations: proposal.cancelled.length,
    transactionIndex: Number(proposal.transactionIndex),
  };
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

/**
 * Squads V4 account types (for transaction discriminators)
 */
export enum SquadsAccountType {
  VAULT = 0,
  CONFIG = 1,
}

/**
 * Squads V4 instruction discriminator values
 */
export enum SquadsInstructionType {
  ADD_MEMBER = 0,
  REMOVE_MEMBER = 1,
  CHANGE_THRESHOLD = 2,
}

/**
 * Human-readable names for Squads instructions
 */
export const SquadsInstructionName: Record<SquadsInstructionType, string> = {
  [SquadsInstructionType.ADD_MEMBER]: 'AddMember',
  [SquadsInstructionType.REMOVE_MEMBER]: 'RemoveMember',
  [SquadsInstructionType.CHANGE_THRESHOLD]: 'ChangeThreshold',
};

/**
 * Squads V4 account discriminators (Anchor 8-byte discriminators)
 * From Squads V4 SDK - first 8 bytes of SHA256 hash of "account:account_name"
 */
export const SQUADS_ACCOUNT_DISCRIMINATORS: Record<
  SquadsAccountType,
  Uint8Array
> = {
  [SquadsAccountType.VAULT]: new Uint8Array([
    168, 250, 162, 100, 81, 14, 162, 207,
  ]),
  [SquadsAccountType.CONFIG]: new Uint8Array([
    94, 8, 4, 35, 113, 139, 139, 112,
  ]),
};

/**
 * Squads V4 instruction discriminators (Anchor 8-byte discriminators)
 * From Squads V4 SDK - first 8 bytes of SHA256 hash of "global:instruction_name"
 */
export const SQUADS_INSTRUCTION_DISCRIMINATORS: Record<
  SquadsInstructionType,
  Uint8Array
> = {
  [SquadsInstructionType.ADD_MEMBER]: new Uint8Array([
    105, 59, 69, 187, 29, 191, 111, 175,
  ]),
  [SquadsInstructionType.REMOVE_MEMBER]: new Uint8Array([
    117, 255, 234, 193, 246, 150, 28, 141,
  ]),
  [SquadsInstructionType.CHANGE_THRESHOLD]: new Uint8Array([
    134, 5, 181, 153, 254, 178, 214, 132,
  ]),
};

/**
 * Squads V4 Permission flags (bitmask)
 * From Squads documentation: https://docs.squads.so/main/development-guides/v4-sdk
 */
export enum SquadsPermission {
  PROPOSER = 1,
  VOTER = 2,
  EXECUTOR = 4,
  ALL_PERMISSIONS = 7, // Combination of all permissions (Proposer + Voter + Executor)
}

/**
 * Decode a permissions bitmask into a human-readable string
 */
export function decodePermissions(mask: number): string {
  const permissions: string[] = [];
  if (mask & SquadsPermission.PROPOSER) permissions.push('Proposer');
  if (mask & SquadsPermission.VOTER) permissions.push('Voter');
  if (mask & SquadsPermission.EXECUTOR) permissions.push('Executor');

  return permissions.length > 0 ? permissions.join(', ') : 'None';
}

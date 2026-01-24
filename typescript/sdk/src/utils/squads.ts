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

// ============================================================================
// Squads V4 Types
// ============================================================================

/**
 * Status information for a Squads proposal
 */
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

/**
 * Emoji status indicators for Squads transactions
 */
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

/**
 * Squads proposal status values
 */
export const SquadsProposalStatus = {
  Draft: 'Draft',
  Active: 'Active',
  Rejected: 'Rejected',
  Approved: 'Approved',
  Executing: 'Executing',
  Executed: 'Executed',
  Cancelled: 'Cancelled',
} as const;

/**
 * Type for Squads proposal status
 */
export type SquadsProposalStatus =
  (typeof SquadsProposalStatus)[keyof typeof SquadsProposalStatus];

/**
 * Squads V4 account types (for transaction discriminators)
 * Also used to identify transaction types (VaultTransaction vs ConfigTransaction)
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

// ============================================================================
// Squads V4 Parsing Functions
// ============================================================================

/**
 * Get the status emoji and description for a Squads transaction
 *
 * @param statusKind - The proposal status kind
 * @param approvals - Number of approvals received
 * @param threshold - Approval threshold required
 * @param transactionIndex - Index of the transaction
 * @param staleTransactionIndex - Index after which transactions are considered stale
 * @returns Status emoji string
 */
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

/**
 * Parse basic information from a Squads proposal account
 *
 * @param proposal - The Squads proposal account
 * @returns Parsed proposal data
 */
export function parseSquadProposal(proposal: {
  status: { __kind: string };
  approved: unknown[];
  rejected: unknown[];
  cancelled: unknown[];
  transactionIndex: number | bigint;
}) {
  return {
    status: proposal.status.__kind,
    approvals: proposal.approved.length,
    rejections: proposal.rejected.length,
    cancellations: proposal.cancelled.length,
    transactionIndex: Number(proposal.transactionIndex),
  };
}

/**
 * Decode a permissions bitmask into a human-readable string
 *
 * @param mask - The permission bitmask
 * @returns Comma-separated list of permissions or 'None'
 */
export function decodePermissions(mask: number): string {
  const permissions: string[] = [];
  if (mask & SquadsPermission.PROPOSER) permissions.push('Proposer');
  if (mask & SquadsPermission.VOTER) permissions.push('Voter');
  if (mask & SquadsPermission.EXECUTOR) permissions.push('Executor');

  return permissions.length > 0 ? permissions.join(', ') : 'None';
}

/**
 * Check if transaction account data is a VaultTransaction
 *
 * @param accountData - The account data buffer
 * @returns True if the account is a VaultTransaction
 */
export function isVaultTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
  );
}

/**
 * Check if transaction account data is a ConfigTransaction
 *
 * @param accountData - The account data buffer
 * @returns True if the account is a ConfigTransaction
 */
export function isConfigTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
  );
}

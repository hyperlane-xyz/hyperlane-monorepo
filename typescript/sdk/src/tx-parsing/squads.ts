import {
  SquadsAccountType,
  SquadsInstructionName,
  SquadsInstructionType,
  SquadsPermission,
  SquadsProposalStatus,
  SquadsProposalStatusType,
  SquadsTxStatus,
} from './types.js';

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
 * Decode a permissions bitmask into a human-readable string.
 *
 * @param mask - The permissions bitmask from Squads
 * @returns Comma-separated list of permission names
 */
export function decodeSquadsPermissions(mask: number): string {
  const permissions: string[] = [];
  if (mask & SquadsPermission.PROPOSER) permissions.push('Proposer');
  if (mask & SquadsPermission.VOTER) permissions.push('Voter');
  if (mask & SquadsPermission.EXECUTOR) permissions.push('Executor');

  return permissions.length > 0 ? permissions.join(', ') : 'None';
}

/**
 * Calculate the display status for a Squads transaction.
 *
 * @param statusKind - The proposal status from the Squads account
 * @param approvals - Number of approvals
 * @param threshold - Required threshold for execution
 * @param transactionIndex - The transaction index
 * @param staleTransactionIndex - Index below which transactions are considered stale
 * @returns Status emoji string
 */
export function getSquadsTxStatus(
  statusKind: SquadsProposalStatusType,
  approvals: number,
  threshold: number,
  transactionIndex: number,
  staleTransactionIndex: number,
): string {
  // Check if transaction is stale before checking other statuses
  if (
    transactionIndex < staleTransactionIndex &&
    statusKind !== SquadsProposalStatus.Executed
  ) {
    return SquadsTxStatus.STALE;
  }

  switch (statusKind) {
    case SquadsProposalStatus.Draft:
      return SquadsTxStatus.DRAFT;
    case SquadsProposalStatus.Active:
      return approvals >= threshold
        ? SquadsTxStatus.APPROVED
        : threshold - approvals === 1
          ? SquadsTxStatus.ONE_AWAY
          : SquadsTxStatus.ACTIVE;
    case SquadsProposalStatus.Rejected:
      return SquadsTxStatus.REJECTED;
    case SquadsProposalStatus.Approved:
      return SquadsTxStatus.APPROVED;
    case SquadsProposalStatus.Executing:
      return SquadsTxStatus.EXECUTING;
    case SquadsProposalStatus.Executed:
      return SquadsTxStatus.EXECUTED;
    case SquadsProposalStatus.Cancelled:
      return SquadsTxStatus.CANCELLED;
    default:
      return '❓';
  }
}

/**
 * Check if transaction account data is a VaultTransaction.
 *
 * @param accountData - The raw account data buffer
 * @returns True if this is a VaultTransaction
 */
export function isVaultTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    Buffer.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT]),
  );
}

/**
 * Check if transaction account data is a ConfigTransaction.
 *
 * @param accountData - The raw account data buffer
 * @returns True if this is a ConfigTransaction
 */
export function isConfigTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    Buffer.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG]),
  );
}

/**
 * Format a config action as a parsed transaction.
 *
 * @param action - The config action from Squads types
 * @returns Parsed transaction with type, args, and insight
 */
export function formatSquadsConfigAction(action: {
  __kind: string;
  [key: string]: unknown;
}): {
  type: string;
  args: Record<string, unknown>;
  insight: string;
} | null {
  switch (action.__kind) {
    case 'AddMember': {
      const newMember = action.newMember as {
        key: { toBase58: () => string };
        permissions: { mask: number };
      };
      const member = newMember.key.toBase58();
      const permissionsMask = newMember.permissions.mask;
      const permissionsStr = decodeSquadsPermissions(permissionsMask);

      return {
        type: SquadsInstructionName[SquadsInstructionType.ADD_MEMBER],
        args: {
          member,
          permissions: {
            mask: permissionsMask,
            decoded: permissionsStr,
          },
        },
        insight: `Add member ${member} with ${permissionsStr} permissions`,
      };
    }

    case 'RemoveMember': {
      const oldMember = action.oldMember as { toBase58: () => string };
      const member = oldMember.toBase58();

      return {
        type: SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER],
        args: { member },
        insight: `Remove member ${member}`,
      };
    }

    case 'ChangeThreshold': {
      const newThreshold = action.newThreshold as number;

      return {
        type: SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD],
        args: { threshold: newThreshold },
        insight: `Change threshold to ${newThreshold}`,
      };
    }

    case 'SetTimeLock': {
      const newTimeLock = action.newTimeLock as number;

      return {
        type: 'SetTimeLock',
        args: { timeLock: newTimeLock },
        insight: `Set time lock to ${newTimeLock}s`,
      };
    }

    case 'AddSpendingLimit': {
      return {
        type: 'AddSpendingLimit',
        args: {
          vaultIndex: action.vaultIndex,
          mint: (action.mint as { toBase58: () => string }).toBase58(),
          amount: String(action.amount),
          members: (action.members as Array<{ toBase58: () => string }>).map(
            (m) => m.toBase58(),
          ),
          destinations: (
            action.destinations as Array<{ toBase58: () => string }>
          ).map((d) => d.toBase58()),
        },
        insight: `Add spending limit for vault ${action.vaultIndex}`,
      };
    }

    case 'RemoveSpendingLimit': {
      const spendingLimit = action.spendingLimit as { toBase58: () => string };

      return {
        type: 'RemoveSpendingLimit',
        args: { spendingLimit: spendingLimit.toBase58() },
        insight: `Remove spending limit ${spendingLimit.toBase58()}`,
      };
    }

    default:
      return null;
  }
}

// Re-export types
export {
  SquadsAccountType,
  SquadsInstructionName,
  SquadsInstructionType,
  SquadsPermission,
  SquadsProposalStatus,
  SquadsTxStatus,
} from './types.js';

import { OperationType } from '@safe-global/safe-core-sdk-types';
import z from 'zod';

import { ChainName } from '../types.js';

/**
 * Represents a parsed governance transaction with human-readable details.
 */
export interface ParsedTransaction {
  /** Chain where the transaction is executed */
  chain: ChainName;
  /** Target contract description (e.g., "Mailbox (ethereum 0x...)" */
  to?: string;
  /** Transaction type/function name */
  type?: string;
  /** Parsed function arguments */
  args?: Record<string, unknown>;
  /** Human-readable insight/description */
  insight?: string;
  /** Warnings about the transaction */
  warnings?: string[];
  /** Nested transaction for recursive decoding */
  nestedTx?: ParsedTransaction;
  /** Allow additional properties */
  [key: string]: unknown;
}

/**
 * Status of a pending Safe transaction.
 */
export enum SafeTxStatus {
  /** No confirmations yet */
  NO_CONFIRMATIONS = '🔴',
  /** Some confirmations but not ready */
  PENDING = '🟡',
  /** One confirmation away from threshold */
  ONE_AWAY = '🔵',
  /** Ready to execute (meets threshold) */
  READY_TO_EXECUTE = '🟢',
}

/**
 * Metadata about a pending Safe transaction.
 */
export interface SafeTxMetadata {
  chain: ChainName;
  nonce: number;
  submissionDate: string;
  shortTxHash: string;
  fullTxHash: string;
  confirmations: number;
  threshold: number;
  status: SafeTxStatus;
  balance: string;
}

/**
 * Decoded MultiSend transaction data.
 */
export interface DecodedMultiSendTx {
  operation: OperationType;
  to: string;
  value: string;
  data: string;
}

/**
 * Schema for Safe Transaction Builder file format.
 * This is the format used by the Safe Transaction Builder UI.
 */
export const SafeTxBuilderFileSchema = z.object({
  version: z.string(),
  chainId: z.string(),
  createdAt: z.number(),
  meta: z.object({
    name: z.string(),
    description: z.string().optional(),
    txBuilderVersion: z.string().optional(),
    createdFromSafeAddress: z.string().optional(),
    createdFromOwnerAddress: z.string().optional(),
    checksum: z.string().optional(),
  }),
  transactions: z.array(
    z.object({
      to: z.string(),
      value: z.string(),
      data: z.union([z.string(), z.null()]),
      contractMethod: z
        .object({
          inputs: z.array(z.any()),
          name: z.string(),
          payable: z.boolean(),
        })
        .optional(),
      contractInputsValues: z.record(z.string()).optional(),
    }),
  ),
});

export type SafeTxBuilderFile = z.infer<typeof SafeTxBuilderFileSchema>;

/**
 * Status of a Squads proposal.
 */
export enum SquadsTxStatus {
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
 * Metadata about a pending Squads proposal.
 */
export interface SquadsProposalMetadata {
  chain: ChainName;
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
}

/**
 * Squads V4 proposal status values (matches @sqds/multisig accounts.Proposal status).
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

export type SquadsProposalStatusType =
  (typeof SquadsProposalStatus)[keyof typeof SquadsProposalStatus];

/**
 * Squads V4 account types for transaction discriminators.
 */
export enum SquadsAccountType {
  VAULT = 0,
  CONFIG = 1,
}

/**
 * Squads V4 instruction types.
 */
export enum SquadsInstructionType {
  ADD_MEMBER = 0,
  REMOVE_MEMBER = 1,
  CHANGE_THRESHOLD = 2,
}

/**
 * Human-readable names for Squads instructions.
 */
export const SquadsInstructionName: Record<SquadsInstructionType, string> = {
  [SquadsInstructionType.ADD_MEMBER]: 'AddMember',
  [SquadsInstructionType.REMOVE_MEMBER]: 'RemoveMember',
  [SquadsInstructionType.CHANGE_THRESHOLD]: 'ChangeThreshold',
};

/**
 * Squads V4 Permission flags (bitmask).
 */
export enum SquadsPermission {
  PROPOSER = 1,
  VOTER = 2,
  EXECUTOR = 4,
  ALL_PERMISSIONS = 7,
}

/**
 * Parsed instruction result with human-readable information for Squads.
 */
export interface ParsedSquadsInstruction {
  programId: string;
  programName: string;
  instructionType: string;
  data: Record<string, unknown>;
  accounts: string[];
  warnings: string[];
  insight?: string;
}

/**
 * Parsed Squads transaction result.
 */
export interface ParsedSquadsTransaction extends ParsedTransaction {
  proposalPda?: string;
  transactionIndex?: number;
  multisig?: string;
  instructions?: ParsedTransaction[];
}

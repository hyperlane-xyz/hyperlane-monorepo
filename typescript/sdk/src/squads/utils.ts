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

import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { SvmMultiProtocolSignerAdapter } from '../signers/svm/solana-web3js.js';
import { ChainName } from '../types.js';

import {
  getSquadsKeys,
  partitionSquadsChains,
  SquadsChainName,
} from './config.js';
import { toSquadsProvider } from './provider.js';

/**
 * Overhead added by Squads v4 when wrapping instructions in a vault transaction proposal.
 */
export const SQUADS_PROPOSAL_OVERHEAD = 500;

/**
 * Squads V4 instruction discriminator size (8-byte Anchor discriminator)
 */
export const SQUADS_DISCRIMINATOR_SIZE = 8;

/**
 * Squads V4 account discriminator size (8-byte Anchor discriminator)
 */
export const SQUADS_ACCOUNT_DISCRIMINATOR_SIZE = 8;

export type SquadProposalStatus = {
  chain: SquadsChainName;
  nonce: number;
  status: SquadTxStatus;
  shortTxHash: string;
  fullTxHash: string;
  approvals: number;
  rejections: number;
  cancellations: number;
  threshold: number;
  balance: string;
  submissionDate: string;
};

export type ParsedSquadProposal = Readonly<{
  status: SquadsProposalStatus;
  approvals: number;
  rejections: number;
  cancellations: number;
  transactionIndex: number;
  statusTimestampSeconds: number | undefined;
}>;

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
  UNKNOWN = '❓',
}

export enum SquadsProposalVoteError {
  AlreadyRejected = 'alreadyRejected',
  AlreadyApproved = 'alreadyApproved',
  AlreadyCancelled = 'alreadyCancelled',
}

export type SquadAndProvider = {
  svmProvider: ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>;
  vault: PublicKey;
  multisigPda: PublicKey;
  programId: PublicKey;
};

type SquadsProposalVoteErrorPattern = {
  error: SquadsProposalVoteError;
  patterns: readonly string[];
};

const SQUADS_PROPOSAL_VOTE_ERROR_PATTERNS: readonly SquadsProposalVoteErrorPattern[] =
  [
    {
      // Error 6011 (0x177b)
      error: SquadsProposalVoteError.AlreadyRejected,
      patterns: ['alreadyrejected', '0x177b'],
    },
    {
      // Error 6010 (0x177a)
      error: SquadsProposalVoteError.AlreadyApproved,
      patterns: ['alreadyapproved', '0x177a'],
    },
    {
      // Error 6012 (0x177c)
      error: SquadsProposalVoteError.AlreadyCancelled,
      patterns: ['alreadycancelled', '0x177c'],
    },
  ];

const SQUADS_ERROR_LOG_ARRAY_FIELDS = ['transactionLogs', 'logs'] as const;
const SQUADS_ERROR_STRING_FIELDS = ['cause', 'error', 'originalError'] as const;
const SQUADS_ERROR_STRING_ARRAY_FIELDS = ['errors'] as const;

function parseSquadsProposalVoteErrorText(
  logsText: string,
): SquadsProposalVoteError | undefined {
  const normalizedLogs = logsText.toLowerCase();

  for (const { error, patterns } of SQUADS_PROPOSAL_VOTE_ERROR_PATTERNS) {
    if (patterns.some((pattern) => normalizedLogs.includes(pattern))) {
      return error;
    }
  }

  return undefined;
}

/**
 * Parse known Squads proposal vote/cancel errors from transaction logs.
 * Matches both named errors and their hex error codes.
 */
export function parseSquadsProposalVoteError(
  transactionLogs: readonly string[],
): SquadsProposalVoteError | undefined {
  return parseSquadsProposalVoteErrorText(transactionLogs.join('\n'));
}

/**
 * Parse known Squads proposal vote/cancel errors from an unknown error object.
 * Supports direct string errors and recursively traverses nested wrapper
 * objects to scan `transactionLogs`, `logs`, and `message` string fields.
 */
export function parseSquadsProposalVoteErrorFromError(
  error: unknown,
): SquadsProposalVoteError | undefined {
  if (typeof error === 'string') {
    return parseSquadsProposalVoteErrorText(error);
  }

  if (Array.isArray(error)) {
    const logEntries = error.filter((value): value is string => {
      return typeof value === 'string';
    });
    if (logEntries.length > 0) {
      return parseSquadsProposalVoteError(logEntries);
    }
  }

  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const traversalQueue: unknown[] = [error];
  const visitedObjects = new Set<object>();
  let queueIndex = 0;

  while (queueIndex < traversalQueue.length) {
    const current = traversalQueue[queueIndex];
    queueIndex++;

    if (!current || typeof current !== 'object') {
      continue;
    }

    if (visitedObjects.has(current)) {
      continue;
    }
    visitedObjects.add(current);

    const currentRecord = current as Record<string, unknown>;
    for (const logField of SQUADS_ERROR_LOG_ARRAY_FIELDS) {
      const maybeLogs = currentRecord[logField];
      if (!Array.isArray(maybeLogs)) continue;
      const logs = maybeLogs.filter((v): v is string => typeof v === 'string');
      if (logs.length === 0) continue;
      const parsedError = parseSquadsProposalVoteError(logs);
      if (parsedError) return parsedError;
    }

    if (typeof currentRecord.message === 'string') {
      const parsedError = parseSquadsProposalVoteErrorText(
        currentRecord.message,
      );
      if (parsedError) return parsedError;
    }

    for (const field of SQUADS_ERROR_STRING_FIELDS) {
      const value = currentRecord[field];
      if (typeof value !== 'string') continue;
      const parsedError = parseSquadsProposalVoteErrorText(value);
      if (parsedError) return parsedError;
    }

    for (const field of SQUADS_ERROR_STRING_ARRAY_FIELDS) {
      const value = currentRecord[field];
      if (!Array.isArray(value)) continue;
      const stringValues = value.filter(
        (item): item is string => typeof item === 'string',
      );
      if (stringValues.length === 0) continue;
      const parsedError = parseSquadsProposalVoteError(stringValues);
      if (parsedError) return parsedError;
    }

    for (const nestedValue of Object.values(currentRecord)) {
      if (nestedValue && typeof nestedValue === 'object') {
        traversalQueue.push(nestedValue);
      }
    }
  }

  return undefined;
}

export function getSquadAndProvider(
  chain: ChainName,
  mpp: MultiProtocolProvider,
): SquadAndProvider {
  const { vault, multisigPda, programId } = getSquadsKeys(chain);
  const svmProvider = mpp.getSolanaWeb3Provider(chain);

  return { svmProvider, vault, multisigPda, programId };
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
  const { multisigPda, programId } = getSquadsKeys(chain);

  try {
    const svmProvider = mpp.getSolanaWeb3Provider(chain);
    const squadsProvider = toSquadsProvider(svmProvider);

    const multisig = await accounts.Multisig.fromAccountAddress(
      squadsProvider,
      multisigPda,
    );

    const [proposalPda] = getProposalPda({
      multisigPda,
      transactionIndex: BigInt(transactionIndex),
      programId,
    });

    const proposal = await accounts.Proposal.fromAccountAddress(
      squadsProvider,
      proposalPda,
    );

    return { proposal, multisig, proposalPda };
  } catch (error) {
    rootLogger.warn(
      `Failed to fetch proposal ${transactionIndex} on ${chain}: ${error}`,
    );
    return undefined;
  }
}

export async function getPendingProposalsForChains(
  chains: readonly string[],
  mpp: MultiProtocolProvider,
): Promise<SquadProposalStatus[]> {
  const proposals: SquadProposalStatus[] = [];
  const { squadsChains, nonSquadsChains } = partitionSquadsChains(chains);

  if (nonSquadsChains.length > 0) {
    rootLogger.warn(
      `Skipping chains without Squads config: ${nonSquadsChains.join(', ')}`,
    );
  }

  await Promise.all(
    squadsChains.map(async (chain) => {
      try {
        const { svmProvider, vault, multisigPda, programId } =
          getSquadAndProvider(chain, mpp);
        const squadsProvider = toSquadsProvider(svmProvider);

        const multisig = await accounts.Multisig.fromAccountAddress(
          squadsProvider,
          multisigPda,
        );

        const threshold = Number(multisig.threshold);
        const currentTransactionIndex = Number(multisig.transactionIndex);
        const staleTransactionIndex = Number(multisig.staleTransactionIndex);

        const vaultBalance = await svmProvider.getBalance(vault);
        const nativeToken = mpp.getChainMetadata(chain).nativeToken;
        const decimals = nativeToken?.decimals;
        if (typeof decimals !== 'number') {
          rootLogger.error(`No decimals found for ${chain}`);
          return;
        }
        const nativeTokenSymbol = nativeToken?.symbol;
        if (!nativeTokenSymbol) {
          rootLogger.error(`No native token symbol found for ${chain}`);
          return;
        }
        const balanceFormatted = (vaultBalance / 10 ** decimals).toFixed(5);

        rootLogger.info(
          `Fetching proposals for squads ${multisigPda.toBase58()} on ${chain}`,
        );

        const maxIndexToCheck = Math.max(1, currentTransactionIndex - 10);

        for (let i = currentTransactionIndex; i >= maxIndexToCheck; i--) {
          try {
            const proposalData = await getSquadProposal(chain, mpp, i);
            if (!proposalData) continue;

            const { proposal } = proposalData;
            const parsedProposal = parseSquadProposal(proposal);
            const {
              status: proposalStatus,
              approvals,
              rejections,
              cancellations,
              transactionIndex,
              statusTimestampSeconds,
            } = parsedProposal;

            if (transactionIndex !== i) {
              rootLogger.warn(
                `Skipping proposal ${i} on ${chain} due to index mismatch (parsed ${transactionIndex})`,
              );
              continue;
            }
            const proposalIndex = transactionIndex;

            if (
              proposalStatus === SquadsProposalStatus.Executed ||
              proposalStatus === SquadsProposalStatus.Rejected ||
              proposalStatus === SquadsProposalStatus.Cancelled
            ) {
              continue;
            }

            if (proposalIndex < staleTransactionIndex) continue;

            if (rejections > 0) continue;

            const status = getSquadTxStatus(
              proposalStatus,
              approvals,
              threshold,
              proposalIndex,
              staleTransactionIndex,
            );

            let submissionDate = 'Executing';
            if (
              proposalStatus !== SquadsProposalStatus.Executing &&
              typeof statusTimestampSeconds === 'number'
            ) {
              submissionDate = new Date(
                statusTimestampSeconds * 1000,
              ).toDateString();
            }

            const [transactionPda] = getTransactionPda({
              multisigPda,
              index: BigInt(proposalIndex),
              programId,
            });
            const txHash = transactionPda.toBase58();

            proposals.push({
              chain,
              nonce: proposalIndex,
              status,
              shortTxHash: `${txHash.slice(0, 6)}...${txHash.slice(-4)}`,
              fullTxHash: txHash,
              approvals,
              rejections,
              cancellations,
              threshold,
              balance: `${balanceFormatted} ${nativeTokenSymbol}`,
              submissionDate,
            });
          } catch (error) {
            rootLogger.debug(
              `Skipping proposal due to error: ${String(error)}`,
            );
            continue;
          }
        }
      } catch (error) {
        rootLogger.warn(
          `Skipping chain ${chain} as there was an error getting the squads data: ${error}`,
        );
        return;
      }
    }),
  );

  return proposals.sort(
    (a, b) => a.chain.localeCompare(b.chain) || a.nonce - b.nonce,
  );
}

export const SquadsProposalStatus = {
  Draft: 'Draft',
  Active: 'Active',
  Rejected: 'Rejected',
  Approved: 'Approved',
  Executing: 'Executing',
  Executed: 'Executed',
  Cancelled: 'Cancelled',
} as const satisfies Record<accounts.Proposal['status']['__kind'], string>;
export type SquadsProposalStatus =
  (typeof SquadsProposalStatus)[keyof typeof SquadsProposalStatus];

export function getSquadTxStatus(
  statusKind: SquadsProposalStatus,
  approvals: number,
  threshold: number,
  transactionIndex: number,
  staleTransactionIndex: number,
): SquadTxStatus {
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
      return SquadTxStatus.UNKNOWN;
  }
}

export function parseSquadProposal(
  proposal: accounts.Proposal,
): ParsedSquadProposal {
  const transactionIndex = Number(proposal.transactionIndex);
  assert(
    Number.isSafeInteger(transactionIndex),
    `Squads transaction index exceeds JavaScript safe integer range: ${proposal.transactionIndex.toString()}`,
  );
  const rawStatusTimestamp =
    'timestamp' in proposal.status ? proposal.status.timestamp : undefined;
  const statusTimestampSeconds =
    typeof rawStatusTimestamp !== 'undefined'
      ? Number(rawStatusTimestamp)
      : undefined;
  if (typeof statusTimestampSeconds === 'number') {
    assert(
      Number.isSafeInteger(statusTimestampSeconds),
      `Squads status timestamp exceeds JavaScript safe integer range: ${String(rawStatusTimestamp)}`,
    );
  }

  const parsedProposal: ParsedSquadProposal = {
    status: proposal.status.__kind,
    approvals: proposal.approved.length,
    rejections: proposal.rejected.length,
    cancellations: proposal.cancelled.length,
    transactionIndex,
    statusTimestampSeconds,
  };

  return parsedProposal;
}

/**
 * Squads V4 account types (also used to identify tx types)
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

export const SquadsInstructionName: Record<SquadsInstructionType, string> = {
  [SquadsInstructionType.ADD_MEMBER]: 'AddMember',
  [SquadsInstructionType.REMOVE_MEMBER]: 'RemoveMember',
  [SquadsInstructionType.CHANGE_THRESHOLD]: 'ChangeThreshold',
};

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

export enum SquadsPermission {
  PROPOSER = 1,
  VOTER = 2,
  EXECUTOR = 4,
  ALL_PERMISSIONS = 7,
}

export function decodePermissions(mask: number): string {
  const permissions: string[] = [];
  if (mask & SquadsPermission.PROPOSER) permissions.push('Proposer');
  if (mask & SquadsPermission.VOTER) permissions.push('Voter');
  if (mask & SquadsPermission.EXECUTOR) permissions.push('Executor');

  return permissions.length > 0 ? permissions.join(', ') : 'None';
}

async function getNextSquadsTransactionIndex(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
): Promise<bigint> {
  const { svmProvider, multisigPda, programId } = getSquadAndProvider(
    chain,
    mpp,
  );
  const squadsProvider = toSquadsProvider(svmProvider);

  const multisig = await accounts.Multisig.fromAccountAddress(
    squadsProvider,
    multisigPda,
  );

  const currentIndex = BigInt(multisig.transactionIndex.toString());
  const nextIndex = currentIndex + 1n;

  const accountInfo = await svmProvider.getAccountInfo(multisigPda);
  if (accountInfo && !accountInfo.owner.equals(programId)) {
    rootLogger.warn(
      `WARNING: Multisig account owner (${accountInfo.owner.toBase58()}) does not match expected program ID (${programId.toBase58()})`,
    );
  }

  return nextIndex;
}

function buildVaultTransactionMessage(
  vaultPda: PublicKey,
  ixs: readonly TransactionInstruction[],
  recentBlockhash: string,
): TransactionMessage {
  return new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash,
    instructions: [...ixs],
  });
}

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

export async function buildSquadsVaultTransactionProposal(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  ixs: readonly TransactionInstruction[],
  creator: PublicKey,
  memo?: string,
): Promise<{
  instructions: TransactionInstruction[];
  transactionIndex: bigint;
}> {
  const { svmProvider, vault, multisigPda, programId } = getSquadAndProvider(
    chain,
    mpp,
  );

  const transactionIndex = await getNextSquadsTransactionIndex(chain, mpp);

  const { blockhash } = await svmProvider.getLatestBlockhash();
  const transactionMessage = buildVaultTransactionMessage(
    vault,
    ixs,
    blockhash,
  );

  const vaultTxIx = createVaultTransactionInstruction(
    multisigPda,
    transactionIndex,
    creator,
    0,
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

export async function buildSquadsProposalRejection(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: bigint,
  member: PublicKey,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const { multisigPda, programId } = getSquadAndProvider(chain, mpp);

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

export async function buildSquadsProposalCancellation(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: bigint,
  member: PublicKey,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const { multisigPda, programId } = getSquadAndProvider(chain, mpp);

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

export async function submitProposalToSquads(
  chain: SquadsChainName,
  vaultInstructions: readonly TransactionInstruction[],
  mpp: MultiProtocolProvider,
  signerAdapter: SvmMultiProtocolSignerAdapter,
  memo?: string,
): Promise<void> {
  try {
    const creatorPublicKey = signerAdapter.publicKey();

    const { instructions: proposalInstructions, transactionIndex } =
      await buildSquadsVaultTransactionProposal(
        chain,
        mpp,
        vaultInstructions,
        creatorPublicKey,
        memo,
      );

    const createSignature =
      await signerAdapter.buildAndSendTransaction(proposalInstructions);

    rootLogger.info(`Proposal created: ${createSignature}`);
    rootLogger.info(`Transaction index: ${transactionIndex}`);

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
    rootLogger.info(`Proposal approved: ${approveSignature}`);
  } catch (error) {
    rootLogger.error(`Failed to submit proposal to Squads: ${error}`);
    throw error;
  }
}

export function isVaultTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
  );
}

export function isConfigTransaction(accountData: Buffer): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  return discriminator.equals(
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
  );
}

export async function getTransactionType(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
): Promise<SquadsAccountType> {
  const { svmProvider, multisigPda, programId } = getSquadAndProvider(
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

export async function executeProposal(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
  signerAdapter: SvmMultiProtocolSignerAdapter,
): Promise<void> {
  const { svmProvider, multisigPda, programId } = getSquadAndProvider(
    chain,
    mpp,
  );

  const proposalData = await getSquadProposal(chain, mpp, transactionIndex);
  if (!proposalData) {
    throw new Error(`Failed to fetch proposal ${transactionIndex} on ${chain}`);
  }

  const { proposal } = proposalData;

  if (proposal.status.__kind !== SquadsProposalStatus.Approved) {
    throw new Error(
      `Proposal ${transactionIndex} on ${chain} is not approved (status: ${proposal.status.__kind})`,
    );
  }

  const txType = await getTransactionType(chain, mpp, transactionIndex);
  rootLogger.info(
    `Executing ${txType} proposal ${transactionIndex} on ${chain}`,
  );

  const executorPublicKey = signerAdapter.publicKey();

  try {
    let instruction: TransactionInstruction;

    if (txType === SquadsAccountType.VAULT) {
      const { instruction: vaultInstruction, lookupTableAccounts } =
        await instructions.vaultTransactionExecute({
          connection: svmProvider,
          multisigPda,
          transactionIndex: BigInt(transactionIndex),
          member: executorPublicKey,
          programId,
        });

      if (lookupTableAccounts.length > 0) {
        throw new Error(
          `Transaction requires ${lookupTableAccounts.length} address lookup table(s). Versioned transactions are not supported on ${chain}.`,
        );
      }

      instruction = vaultInstruction;
    } else {
      instruction = instructions.configTransactionExecute({
        multisigPda,
        transactionIndex: BigInt(transactionIndex),
        member: executorPublicKey,
        programId,
      });
    }

    const signature = await signerAdapter.buildAndSendTransaction([
      instruction,
    ]);

    rootLogger.info(
      `Executed proposal ${transactionIndex} on ${chain}: ${signature}`,
    );
  } catch (error) {
    rootLogger.error(
      `Error executing proposal ${transactionIndex} on ${chain}: ${String(error)}`,
    );
    throw error;
  }
}

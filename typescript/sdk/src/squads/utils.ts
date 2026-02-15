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

import {
  getSquadsKeysForResolvedChain,
  partitionSquadsChains,
  resolveSquadsChainName,
  SquadsChainName,
} from './config.js';
import {
  isGenericObjectStringifiedValue,
  stringifyUnknownSquadsError,
} from './error-format.js';
import { toSquadsProvider } from './provider.js';
import { assertValidTransactionIndexInput } from './validation.js';
export { assertValidTransactionIndexInput } from './validation.js';

/**
 * Overhead added by Squads v4 when wrapping instructions in a vault transaction proposal.
 */
export const SQUADS_PROPOSAL_OVERHEAD = 500;
const SQUADS_PROPOSAL_LOOKBACK_COUNT = 10;

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
  status: string;
  approvals: number;
  rejections: number;
  cancellations: number;
  transactionIndex: number;
  statusTimestampSeconds: number | undefined;
}>;

export type ParsedSquadMultisig = Readonly<{
  threshold: number;
  currentTransactionIndex: number;
  staleTransactionIndex: number;
  timeLock: number;
}>;

export type NormalizeSquadsAddressValueResult =
  | { address: string; error: undefined }
  | { address: undefined; error: string };

export type NormalizeSquadsAddressListResult = Readonly<{
  addresses: string[];
  invalidEntries: number;
}>;

export type ParsedSquadsMultisigMember = Readonly<{
  key: string;
  permissions: unknown;
}>;

export type ParseSquadsMultisigMembersResult = Readonly<{
  members: ParsedSquadsMultisigMember[];
  invalidEntries: number;
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
  chain: SquadsChainName;
  svmProvider: ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>;
  vault: PublicKey;
  multisigPda: PublicKey;
  programId: PublicKey;
};

type SolanaWeb3Provider = ReturnType<
  MultiProtocolProvider['getSolanaWeb3Provider']
>;

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

const SQUADS_ERROR_LOG_ARRAY_FIELDS = [
  'transactionLogs',
  'logs',
  'logMessages',
  'transactionLogMessages',
] as const;
const SQUADS_ERROR_STRING_ARRAY_FIELDS = ['errors'] as const;
const SQUADS_ERROR_STRING_FIELDS = [
  'cause',
  'error',
  'originalError',
  'shortMessage',
  'details',
] as const;
const SQUADS_ERROR_KNOWN_ARRAY_FIELD_NAMES = new Set<string>([
  ...SQUADS_ERROR_LOG_ARRAY_FIELDS,
  ...SQUADS_ERROR_STRING_ARRAY_FIELDS,
]);
const SQUADS_LOG_FIELD_NAME_CACHE = new Map<string, boolean>();
const SAFE_INTEGER_DECIMAL_PATTERN = /^-?\d+$/;
const LIKELY_MISSING_SQUADS_ACCOUNT_ERROR_PATTERNS = [
  'account does not exist',
  'account not found',
  'could not find account',
  'failed to find account',
] as const;

function tokenizeFieldName(fieldName: string): string[] {
  return fieldName
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .split('_')
    .filter((token) => token.length > 0);
}

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

function getObjectRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object, got ${getUnknownValueTypeName(value)}`,
  );

  return value as Record<string, unknown>;
}

function formatUnknownErrorForMessage(error: unknown): string {
  return stringifyUnknownSquadsError(error, {
    preferErrorMessageForErrorInstances: true,
  });
}

export function normalizeSquadsAddressValue(
  value: unknown,
): NormalizeSquadsAddressValueResult {
  let rawAddressValue: string;

  if (typeof value === 'string') {
    rawAddressValue = value;
  } else {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        address: undefined,
        error: `expected string or object with toBase58(), got ${getUnknownValueTypeName(value)}`,
      };
    }

    const toBase58Candidate = (value as { toBase58?: unknown }).toBase58;
    if (typeof toBase58Candidate !== 'function') {
      return {
        address: undefined,
        error: 'missing toBase58() method',
      };
    }

    try {
      const toBase58Value = toBase58Candidate.call(value);
      rawAddressValue =
        typeof toBase58Value === 'string'
          ? toBase58Value
          : String(toBase58Value);
    } catch (error) {
      return {
        address: undefined,
        error: `failed to stringify key (${formatUnknownErrorForMessage(error)})`,
      };
    }
  }

  const trimmedAddressValue = rawAddressValue.trim();
  if (trimmedAddressValue.length === 0) {
    return {
      address: undefined,
      error: 'address value is empty',
    };
  }

  if (isGenericObjectStringifiedValue(trimmedAddressValue)) {
    return {
      address: undefined,
      error: 'address value is not a meaningful identifier',
    };
  }

  try {
    return {
      address: new PublicKey(trimmedAddressValue).toBase58(),
      error: undefined,
    };
  } catch {
    return {
      address: undefined,
      error: 'address value is not a valid Solana address',
    };
  }
}

export function normalizeSquadsAddressList(
  values: unknown,
): NormalizeSquadsAddressListResult {
  assert(
    Array.isArray(values),
    `Expected address list to be an array, got ${getUnknownValueTypeName(values)}`,
  );

  const addresses: string[] = [];
  let invalidEntries = 0;

  for (const value of values) {
    const normalizedAddress = normalizeSquadsAddressValue(value);
    if (normalizedAddress.address) {
      addresses.push(normalizedAddress.address);
    } else {
      invalidEntries += 1;
    }
  }

  return { addresses, invalidEntries };
}

export function parseSquadsMultisigMembers(
  members: unknown,
): ParseSquadsMultisigMembersResult {
  assert(
    Array.isArray(members),
    `Expected multisig members to be an array, got ${getUnknownValueTypeName(members)}`,
  );

  const parsedMembers: ParsedSquadsMultisigMember[] = [];
  let invalidEntries = 0;

  for (const member of members) {
    if (!member || typeof member !== 'object') {
      invalidEntries += 1;
      continue;
    }

    const memberRecord = member as { key?: unknown; permissions?: unknown };
    const normalizedMemberKey = normalizeSquadsAddressValue(memberRecord.key);
    if (!normalizedMemberKey.address) {
      invalidEntries += 1;
      continue;
    }

    parsedMembers.push({
      key: normalizedMemberKey.address,
      permissions: memberRecord.permissions ?? null,
    });
  }

  return {
    members: parsedMembers,
    invalidEntries,
  };
}

function isLikelyLogArrayFieldName(fieldName: string): boolean {
  const cached = SQUADS_LOG_FIELD_NAME_CACHE.get(fieldName);
  if (typeof cached === 'boolean') {
    return cached;
  }

  const tokens = tokenizeFieldName(fieldName);
  const result = tokens.includes('log') || tokens.includes('logs');
  SQUADS_LOG_FIELD_NAME_CACHE.set(fieldName, result);
  return result;
}

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

function parseSquadsProposalVoteErrorFromUnknownLogs(
  value: unknown,
): SquadsProposalVoteError | undefined {
  if (typeof value === 'string') {
    return parseSquadsProposalVoteErrorText(value);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const logEntries = value.filter((entry): entry is string => {
    return typeof entry === 'string';
  });

  if (logEntries.length === 0) {
    return undefined;
  }

  return parseSquadsProposalVoteErrorText(logEntries.join('\n'));
}

/**
 * Parse known Squads proposal vote/cancel errors from transaction logs.
 * Matches both named errors and their hex error codes.
 */
export function parseSquadsProposalVoteError(
  transactionLogs: unknown,
): SquadsProposalVoteError | undefined {
  return parseSquadsProposalVoteErrorFromUnknownLogs(transactionLogs);
}

/**
 * Parse known Squads proposal vote/cancel errors from an unknown error object.
 * Supports direct string errors, direct log arrays, and recursively traverses
 * nested wrapper objects to scan known log array fields
 * (`transactionLogs`, `logs`, `logMessages`, `transactionLogMessages`),
 * log-like array keys, `message`, and common string wrapper fields (`cause`,
 * `error`, `originalError`, `shortMessage`, `details`).
 */
export function parseSquadsProposalVoteErrorFromError(
  error: unknown,
): SquadsProposalVoteError | undefined {
  if (typeof error === 'string') {
    return parseSquadsProposalVoteErrorText(error);
  }

  const parsedFromDirectArray =
    parseSquadsProposalVoteErrorFromUnknownLogs(error);
  if (parsedFromDirectArray) {
    return parsedFromDirectArray;
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
      const parsedError =
        parseSquadsProposalVoteErrorFromUnknownLogs(maybeLogs);
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
      const parsedError = parseSquadsProposalVoteErrorFromUnknownLogs(value);
      if (parsedError) return parsedError;
    }

    for (const [key, nestedValue] of Object.entries(currentRecord)) {
      if (
        !SQUADS_ERROR_KNOWN_ARRAY_FIELD_NAMES.has(key) &&
        isLikelyLogArrayFieldName(key)
      ) {
        const parsedError =
          parseSquadsProposalVoteErrorFromUnknownLogs(nestedValue);
        if (parsedError) return parsedError;
      }

      if (nestedValue && typeof nestedValue === 'object') {
        traversalQueue.push(nestedValue);
      }
    }
  }

  return undefined;
}

function toSafeInteger(
  value: unknown,
  fieldLabel: string,
  options?: { nonNegative?: boolean; positive?: boolean },
): number {
  const { parsedValue, displayValue } = normalizeSafeIntegerValue(value);
  assert(
    Number.isSafeInteger(parsedValue),
    `Squads ${fieldLabel} must be a JavaScript safe integer: ${displayValue}`,
  );
  if (options?.nonNegative) {
    assert(
      parsedValue >= 0,
      `Squads ${fieldLabel} must be a non-negative JavaScript safe integer: ${displayValue}`,
    );
  }
  if (options?.positive) {
    assert(
      parsedValue > 0,
      `Squads ${fieldLabel} must be a positive JavaScript safe integer: ${displayValue}`,
    );
  }
  return parsedValue;
}

function normalizeSafeIntegerValue(value: unknown): {
  parsedValue: number;
  displayValue: string;
} {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return { parsedValue: Number(value), displayValue: String(value) };
  }

  if (!value || typeof value !== 'object') {
    return { parsedValue: Number.NaN, displayValue: String(value) };
  }

  let displayValue: string;
  try {
    displayValue = String(value);
  } catch {
    const toStringCandidate = (value as { toString?: unknown }).toString;
    if (typeof toStringCandidate !== 'function') {
      return {
        parsedValue: Number.NaN,
        displayValue: Object.prototype.toString.call(value),
      };
    }
    return { parsedValue: Number.NaN, displayValue: '[unstringifiable value]' };
  }

  if (!SAFE_INTEGER_DECIMAL_PATTERN.test(displayValue)) {
    return {
      parsedValue: Number.NaN,
      displayValue,
    };
  }

  return { parsedValue: Number(displayValue), displayValue };
}

export function getSquadAndProvider(
  chain: unknown,
  mpp: MultiProtocolProvider,
  svmProviderOverride?: SolanaWeb3Provider,
): SquadAndProvider {
  const normalizedChain = resolveSquadsChainName(chain);
  return getSquadAndProviderForResolvedChain(
    normalizedChain,
    mpp,
    svmProviderOverride,
  );
}

function getSquadAndProviderForResolvedChain(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  svmProviderOverride?: SolanaWeb3Provider,
): SquadAndProvider {
  const { vault, multisigPda, programId } = getSquadsKeysForResolvedChain(
    chain,
  );
  const svmProvider =
    svmProviderOverride ?? mpp.getSolanaWeb3Provider(chain);

  return { chain, svmProvider, vault, multisigPda, programId };
}

export async function getSquadProposal(
  chain: unknown,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<
  | {
      proposal: accounts.Proposal;
      multisig: accounts.Multisig;
      proposalPda: PublicKey;
    }
  | undefined
> {
  const normalizedChain = resolveSquadsChainName(chain);
  assertValidTransactionIndexInput(transactionIndex, normalizedChain);

  try {
    const proposalAccountData = await getSquadProposalAccountForResolvedChain(
      normalizedChain,
      mpp,
      transactionIndex,
      svmProviderOverride,
    );
    if (!proposalAccountData) {
      return undefined;
    }
    const { svmProvider, ...proposalData } = proposalAccountData;

    const squadsProvider = toSquadsProvider(svmProvider);

    const multisig = await accounts.Multisig.fromAccountAddress(
      squadsProvider,
      proposalData.multisigPda,
    );

    return { ...proposalData, multisig };
  } catch (error) {
    const errorText = formatUnknownErrorForMessage(error);
    rootLogger.warn(
      `Failed to fetch proposal ${transactionIndex} on ${normalizedChain}: ${errorText}`,
    );
    return undefined;
  }
}

export async function getSquadProposalAccount(
  chain: unknown,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<
  | {
      proposal: accounts.Proposal;
      proposalPda: PublicKey;
      multisigPda: PublicKey;
      programId: PublicKey;
    }
  | undefined
> {
  const normalizedChain = resolveSquadsChainName(chain);
  assertValidTransactionIndexInput(transactionIndex, normalizedChain);

  const proposalAccountData = await getSquadProposalAccountForResolvedChain(
    normalizedChain,
    mpp,
    transactionIndex,
    svmProviderOverride,
  );
  if (!proposalAccountData) {
    return undefined;
  }

  const { svmProvider: _ignoredSvmProvider, ...proposalData } =
    proposalAccountData;
  return proposalData;
}

type SquadProposalAccountWithProvider = {
  proposal: accounts.Proposal;
  proposalPda: PublicKey;
  multisigPda: PublicKey;
  programId: PublicKey;
  svmProvider: SolanaWeb3Provider;
};

async function getSquadProposalAccountForResolvedChain(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<SquadProposalAccountWithProvider | undefined> {
  try {
    const { svmProvider, multisigPda, programId } =
      getSquadAndProviderForResolvedChain(
        chain,
        mpp,
        svmProviderOverride,
      );
    const squadsProvider = toSquadsProvider(svmProvider);

    const [proposalPda] = getProposalPda({
      multisigPda,
      transactionIndex: BigInt(transactionIndex),
      programId,
    });

    const proposal = await accounts.Proposal.fromAccountAddress(
      squadsProvider,
      proposalPda,
    );

    return { proposal, proposalPda, multisigPda, programId, svmProvider };
  } catch (error) {
    const errorText = formatUnknownErrorForMessage(error);
    if (isLikelyMissingSquadsAccountError(error)) {
      rootLogger.debug(
        `Proposal ${transactionIndex} on ${chain} was not found: ${errorText}`,
      );
      return undefined;
    }

    rootLogger.warn(
      `Failed to fetch proposal ${transactionIndex} on ${chain}: ${errorText}`,
    );
    return undefined;
  }
}

export function isLikelyMissingSquadsAccountError(error: unknown): boolean {
  const normalizedErrorText = formatUnknownErrorForMessage(error).toLowerCase();
  return LIKELY_MISSING_SQUADS_ACCOUNT_ERROR_PATTERNS.some((pattern) =>
    normalizedErrorText.includes(pattern),
  );
}

export async function getPendingProposalsForChains(
  chains: unknown,
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
          getSquadAndProviderForResolvedChain(chain, mpp);
        const squadsProvider = toSquadsProvider(svmProvider);

        const multisig = await accounts.Multisig.fromAccountAddress(
          squadsProvider,
          multisigPda,
        );
        const { threshold, currentTransactionIndex, staleTransactionIndex } =
          parseSquadMultisig(multisig, `${chain} multisig`);

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

        const minIndexToCheck = getMinimumProposalIndexToCheck(
          currentTransactionIndex,
        );

        for (let i = currentTransactionIndex; i >= minIndexToCheck; i--) {
          try {
            const proposalData = await getSquadProposalAccountForResolvedChain(
              chain,
              mpp,
              i,
              svmProvider,
            );
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
              !shouldTrackPendingSquadsProposal(
                proposalStatus,
                proposalIndex,
                staleTransactionIndex,
                rejections,
              )
            ) {
              continue;
            }

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
            const errorText = formatUnknownErrorForMessage(error);
            rootLogger.debug(
              `Skipping proposal ${i} on ${chain} due to error: ${errorText}`,
            );
            continue;
          }
        }
      } catch (error) {
        const errorText = formatUnknownErrorForMessage(error);
        rootLogger.warn(
          `Skipping chain ${chain} as there was an error getting the squads data: ${errorText}`,
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

export function isTerminalSquadsProposalStatus(statusKind: unknown): boolean {
  const normalizedStatusKind = normalizeStatusKind(statusKind);
  return (
    normalizedStatusKind === SquadsProposalStatus.Executed ||
    normalizedStatusKind === SquadsProposalStatus.Rejected ||
    normalizedStatusKind === SquadsProposalStatus.Cancelled
  );
}

export function canModifySquadsProposalStatus(statusKind: unknown): boolean {
  const normalizedStatusKind = normalizeStatusKind(statusKind);
  return (
    normalizedStatusKind === SquadsProposalStatus.Active ||
    normalizedStatusKind === SquadsProposalStatus.Approved
  );
}

export type SquadsProposalModification = Readonly<{
  action: 'reject' | 'cancel';
  pastTenseAction: 'rejected' | 'cancelled';
}>;

export function deriveSquadsProposalModification(
  statusKind: unknown,
): SquadsProposalModification | undefined {
  const normalizedStatusKind = normalizeStatusKind(statusKind);
  if (normalizedStatusKind === SquadsProposalStatus.Active) {
    return {
      action: 'reject',
      pastTenseAction: 'rejected',
    };
  }
  if (normalizedStatusKind === SquadsProposalStatus.Approved) {
    return {
      action: 'cancel',
      pastTenseAction: 'cancelled',
    };
  }

  return undefined;
}

export function isStaleSquadsProposal(
  statusKind: unknown,
  transactionIndex: number,
  staleTransactionIndex: number,
): boolean {
  const normalizedStatusKind = normalizeStatusKind(statusKind);
  assert(
    Number.isSafeInteger(transactionIndex) && transactionIndex >= 0,
    `Expected transaction index to be a non-negative safe integer, got ${transactionIndex}`,
  );
  assert(
    Number.isSafeInteger(staleTransactionIndex) && staleTransactionIndex >= 0,
    `Expected stale transaction index to be a non-negative safe integer, got ${staleTransactionIndex}`,
  );

  return (
    transactionIndex < staleTransactionIndex &&
    !isTerminalSquadsProposalStatus(normalizedStatusKind)
  );
}

export function shouldTrackPendingSquadsProposal(
  statusKind: unknown,
  transactionIndex: number,
  staleTransactionIndex: number,
  rejections: number,
): boolean {
  assert(
    Number.isSafeInteger(rejections) && rejections >= 0,
    `Expected rejections to be a non-negative safe integer, got ${rejections}`,
  );
  return (
    rejections === 0 &&
    !isTerminalSquadsProposalStatus(statusKind) &&
    !isStaleSquadsProposal(statusKind, transactionIndex, staleTransactionIndex)
  );
}

export function getSquadTxStatus(
  statusKind: unknown,
  approvals: number,
  threshold: number,
  transactionIndex: number,
  staleTransactionIndex: number,
): SquadTxStatus {
  const normalizedStatusKind = normalizeStatusKind(statusKind);
  assert(
    Number.isSafeInteger(approvals) && approvals >= 0,
    `Expected approvals to be a non-negative safe integer, got ${approvals}`,
  );
  assert(
    Number.isSafeInteger(threshold) && threshold > 0,
    `Expected threshold to be a positive safe integer, got ${threshold}`,
  );
  assert(
    Number.isSafeInteger(transactionIndex) && transactionIndex >= 0,
    `Expected transaction index to be a non-negative safe integer, got ${transactionIndex}`,
  );
  assert(
    Number.isSafeInteger(staleTransactionIndex) && staleTransactionIndex >= 0,
    `Expected stale transaction index to be a non-negative safe integer, got ${staleTransactionIndex}`,
  );

  if (
    isStaleSquadsProposal(
      normalizedStatusKind,
      transactionIndex,
      staleTransactionIndex,
    )
  ) {
    return SquadTxStatus.STALE;
  }

  switch (normalizedStatusKind) {
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

export function getMinimumProposalIndexToCheck(
  currentTransactionIndex: number,
  lookbackCount = SQUADS_PROPOSAL_LOOKBACK_COUNT,
): number {
  assert(
    Number.isSafeInteger(currentTransactionIndex) &&
      currentTransactionIndex >= 0,
    `Expected current transaction index to be a non-negative safe integer, got ${currentTransactionIndex}`,
  );
  assert(
    Number.isSafeInteger(lookbackCount) && lookbackCount >= 0,
    `Expected lookback count to be a non-negative safe integer, got ${lookbackCount}`,
  );

  return Math.max(0, currentTransactionIndex - lookbackCount);
}

export function parseSquadProposal(
  proposal: unknown,
): ParsedSquadProposal {
  const proposalRecord = getObjectRecord(proposal, 'Squads proposal');
  const approvals = getProposalVoteCount(proposalRecord, 'approved');
  const rejections = getProposalVoteCount(proposalRecord, 'rejected');
  const cancellations = getProposalVoteCount(proposalRecord, 'cancelled');
  const { statusKind, rawStatusTimestamp } =
    getProposalStatusMetadata(proposalRecord);
  const transactionIndex =
    parseSquadProposalTransactionIndex(proposalRecord);
  const statusTimestampSeconds =
    typeof rawStatusTimestamp !== 'undefined'
      ? toSafeInteger(rawStatusTimestamp, 'status timestamp', {
          nonNegative: true,
        })
      : undefined;

  const parsedProposal: ParsedSquadProposal = {
    status: statusKind,
    approvals,
    rejections,
    cancellations,
    transactionIndex,
    statusTimestampSeconds,
  };

  return parsedProposal;
}

export function parseSquadProposalTransactionIndex(
  proposal: unknown,
): number {
  const proposalRecord = getObjectRecord(proposal, 'Squads proposal');
  return toSafeInteger(proposalRecord.transactionIndex, 'transaction index', {
    nonNegative: true,
  });
}

function getProposalStatusMetadata(proposal: Record<string, unknown>): {
  statusKind: string;
  rawStatusTimestamp: unknown;
} {
  const status = proposal.status;
  assert(
    status && typeof status === 'object',
    'Squads proposal status must be an object',
  );

  const statusRecord = status as Record<string, unknown>;
  const normalizedStatusKind = normalizeStatusKind(
    statusRecord.__kind,
    'Squads proposal status kind must be a string',
    'Squads proposal status kind must be a non-empty string',
  );

  return {
    statusKind: normalizedStatusKind,
    rawStatusTimestamp: statusRecord.timestamp,
  };
}

function normalizeStatusKind(
  statusKind: unknown,
  nonStringMessage = `Expected status kind to be a string, got ${typeof statusKind}`,
  emptyMessage = 'Expected status kind to be a non-empty string',
): string {
  assert(typeof statusKind === 'string', nonStringMessage);
  const normalizedStatusKind = statusKind.trim();
  assert(normalizedStatusKind.length > 0, emptyMessage);
  return normalizedStatusKind;
}

function getProposalVoteCount(
  proposal: Record<string, unknown>,
  fieldName: 'approved' | 'rejected' | 'cancelled',
): number {
  const fieldValue = proposal[fieldName];
  assert(
    Array.isArray(fieldValue),
    `Squads proposal ${fieldName} votes must be an array`,
  );
  return fieldValue.length;
}

export function parseSquadMultisig(
  multisig: unknown,
  fieldPrefix = 'multisig',
): ParsedSquadMultisig {
  const multisigRecord = getObjectRecord(
    multisig,
    `Squads ${fieldPrefix}`,
  );
  const threshold = toSafeInteger(
    multisigRecord.threshold,
    `${fieldPrefix} threshold`,
    {
      positive: true,
    },
  );
  const currentTransactionIndex = toSafeInteger(
    multisigRecord.transactionIndex,
    `${fieldPrefix} transaction index`,
    { nonNegative: true },
  );
  const staleTransactionIndex = toSafeInteger(
    multisigRecord.staleTransactionIndex,
    `${fieldPrefix} stale transaction index`,
    { nonNegative: true },
  );
  const timeLock = toSafeInteger(
    multisigRecord.timeLock,
    `${fieldPrefix} timelock`,
    {
      nonNegative: true,
    },
  );
  const memberCount = getMultisigMemberCount(multisigRecord, fieldPrefix);

  assert(
    staleTransactionIndex <= currentTransactionIndex,
    `Squads ${fieldPrefix} stale transaction index must be less than or equal to transaction index: ${staleTransactionIndex} > ${currentTransactionIndex}`,
  );
  if (typeof memberCount === 'number') {
    assert(
      threshold <= memberCount,
      `Squads ${fieldPrefix} threshold must be less than or equal to member count: ${threshold} > ${memberCount}`,
    );
  }

  return {
    threshold,
    currentTransactionIndex,
    staleTransactionIndex,
    timeLock,
  };
}

function getMultisigMemberCount(
  multisig: Record<string, unknown>,
  fieldPrefix: string,
): number | undefined {
  const members = multisig.members;
  if (typeof members === 'undefined') {
    return undefined;
  }

  assert(
    Array.isArray(members),
    `Squads ${fieldPrefix} members must be an array when provided`,
  );

  for (let index = 0; index < members.length; index += 1) {
    const member: unknown = members[index];
    assert(
      member && typeof member === 'object',
      `Squads ${fieldPrefix} members[${index}] must be an object`,
    );
    const memberKey = (member as { key?: unknown }).key;
    assert(
      typeof memberKey !== 'undefined' && memberKey !== null,
      `Squads ${fieldPrefix} members[${index}] must include key`,
    );
    if (typeof memberKey === 'string') {
      assert(
        memberKey.trim().length > 0,
        `Squads ${fieldPrefix} members[${index}] key must be a non-empty string`,
      );
    } else {
      assert(
        typeof memberKey === 'object',
        `Squads ${fieldPrefix} members[${index}] key must be an object or non-empty string`,
      );
      let normalizedMemberKey: string | undefined;
      try {
        normalizedMemberKey = String(memberKey);
      } catch {
        // handled by assertion below
      }
      assert(
        typeof normalizedMemberKey === 'string',
        `Squads ${fieldPrefix} members[${index}] key must be stringifiable`,
      );
      const trimmedMemberKey = normalizedMemberKey.trim();
      assert(
        !isGenericObjectStringifiedValue(trimmedMemberKey),
        `Squads ${fieldPrefix} members[${index}] key must stringify to a meaningful identifier`,
      );
      assert(
        trimmedMemberKey.length > 0,
        `Squads ${fieldPrefix} members[${index}] key must resolve to a non-empty string`,
      );
    }
  }

  return members.length;
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

export function decodePermissions(mask: unknown): string {
  assert(
    typeof mask === 'number',
    `Expected permission mask to be a number, got ${getUnknownValueTypeName(mask)}`,
  );
  assert(
    Number.isSafeInteger(mask) && mask >= 0,
    `Expected permission mask to be a non-negative safe integer, got ${String(mask)}`,
  );

  const permissions: string[] = [];
  if (mask & SquadsPermission.PROPOSER) permissions.push('Proposer');
  if (mask & SquadsPermission.VOTER) permissions.push('Voter');
  if (mask & SquadsPermission.EXECUTOR) permissions.push('Executor');

  return permissions.length > 0 ? permissions.join(', ') : 'None';
}

async function getNextSquadsTransactionIndex(
  chain: SquadsChainName,
  mpp: MultiProtocolProvider,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<bigint> {
  const { svmProvider, multisigPda, programId } =
    getSquadAndProviderForResolvedChain(chain, mpp, svmProviderOverride);
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

function assertValidBigintTransactionIndex(
  transactionIndex: bigint,
  chain: SquadsChainName,
): void {
  assert(
    typeof transactionIndex === 'bigint',
    `Expected transaction index to be a bigint for ${chain}, got ${getUnknownValueTypeName(transactionIndex)}`,
  );
  assert(
    transactionIndex >= 0n,
    `Expected transaction index to be a non-negative bigint for ${chain}, got ${transactionIndex.toString()}`,
  );
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
  chain: unknown,
  mpp: MultiProtocolProvider,
  ixs: readonly TransactionInstruction[],
  creator: PublicKey,
  memo?: string,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<{
  instructions: TransactionInstruction[];
  transactionIndex: bigint;
}> {
  const normalizedChain = resolveSquadsChainName(chain);
  const { svmProvider, vault, multisigPda, programId } =
    getSquadAndProviderForResolvedChain(
      normalizedChain,
      mpp,
      svmProviderOverride,
    );

  const transactionIndex = await getNextSquadsTransactionIndex(
    normalizedChain,
    mpp,
    svmProvider,
  );

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
  chain: unknown,
  mpp: MultiProtocolProvider,
  transactionIndex: bigint,
  member: PublicKey,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const normalizedChain = resolveSquadsChainName(chain);
  assertValidBigintTransactionIndex(transactionIndex, normalizedChain);
  const { multisigPda, programId } = getSquadAndProviderForResolvedChain(
    normalizedChain,
    mpp,
    svmProviderOverride,
  );

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
  chain: unknown,
  mpp: MultiProtocolProvider,
  transactionIndex: bigint,
  member: PublicKey,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const normalizedChain = resolveSquadsChainName(chain);
  assertValidBigintTransactionIndex(transactionIndex, normalizedChain);
  const { multisigPda, programId } = getSquadAndProviderForResolvedChain(
    normalizedChain,
    mpp,
    svmProviderOverride,
  );

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
  chain: unknown,
  vaultInstructions: readonly TransactionInstruction[],
  mpp: MultiProtocolProvider,
  signerAdapter: SvmMultiProtocolSignerAdapter,
  memo?: string,
): Promise<void> {
  try {
    const normalizedChain = resolveSquadsChainName(chain);
    const { svmProvider, multisigPda, programId } =
      getSquadAndProviderForResolvedChain(normalizedChain, mpp);
    const creatorPublicKey = signerAdapter.publicKey();

    const { instructions: proposalInstructions, transactionIndex } =
      await buildSquadsVaultTransactionProposal(
        normalizedChain,
        mpp,
        vaultInstructions,
        creatorPublicKey,
        memo,
        svmProvider,
      );

    const createSignature =
      await signerAdapter.buildAndSendTransaction(proposalInstructions);

    rootLogger.info(`Proposal created: ${createSignature}`);
    rootLogger.info(`Transaction index: ${transactionIndex}`);

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
    rootLogger.error(
      `Failed to submit proposal to Squads: ${formatUnknownErrorForMessage(error)}`,
    );
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
  chain: unknown,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
  svmProviderOverride?: SolanaWeb3Provider,
): Promise<SquadsAccountType> {
  const normalizedChain = resolveSquadsChainName(chain);
  assertValidTransactionIndexInput(transactionIndex, normalizedChain);
  const { svmProvider, multisigPda, programId } =
    getSquadAndProviderForResolvedChain(
      normalizedChain,
      mpp,
      svmProviderOverride,
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
  chain: unknown,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
  signerAdapter: SvmMultiProtocolSignerAdapter,
): Promise<void> {
  const normalizedChain = resolveSquadsChainName(chain);
  assertValidTransactionIndexInput(transactionIndex, normalizedChain);
  const { svmProvider, multisigPda, programId } =
    getSquadAndProviderForResolvedChain(normalizedChain, mpp);

  const proposalData = await getSquadProposal(
    normalizedChain,
    mpp,
    transactionIndex,
    svmProvider,
  );
  if (!proposalData) {
    throw new Error(
      `Failed to fetch proposal ${transactionIndex} on ${normalizedChain}`,
    );
  }

  const { proposal } = proposalData;

  if (proposal.status.__kind !== SquadsProposalStatus.Approved) {
    throw new Error(
      `Proposal ${transactionIndex} on ${normalizedChain} is not approved (status: ${proposal.status.__kind})`,
    );
  }

  const txType = await getTransactionType(
    normalizedChain,
    mpp,
    transactionIndex,
    svmProvider,
  );
  rootLogger.info(
    `Executing ${txType} proposal ${transactionIndex} on ${normalizedChain}`,
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
          `Transaction requires ${lookupTableAccounts.length} address lookup table(s). Versioned transactions are not supported on ${normalizedChain}.`,
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
      `Executed proposal ${transactionIndex} on ${normalizedChain}: ${signature}`,
    );
  } catch (error) {
    rootLogger.error(
      `Error executing proposal ${transactionIndex} on ${normalizedChain}: ${formatUnknownErrorForMessage(error)}`,
    );
    throw error;
  }
}

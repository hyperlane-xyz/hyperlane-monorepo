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

function getRecordFieldOrThrow(
  record: Record<string, unknown>,
  fieldName: string,
  label: string,
): unknown {
  try {
    return record[fieldName];
  } catch (error) {
    throw new Error(
      `Failed to read ${label}: ${formatUnknownErrorForMessage(error)}`,
    );
  }
}

function getArrayLengthOrThrow(
  values: readonly unknown[],
  label: string,
): number {
  let lengthValue: unknown;
  try {
    lengthValue = values.length;
  } catch (error) {
    throw new Error(
      `Failed to read ${label} length: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  if (
    typeof lengthValue !== 'number' ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0
  ) {
    throw new Error(
      `Malformed ${label} length: expected non-negative safe integer, got ${formatSafeIntegerInputValue(lengthValue)}`,
    );
  }

  return lengthValue;
}

function getArrayElementOrThrow(
  values: readonly unknown[],
  index: number,
  label: string,
): unknown {
  try {
    return values[index];
  } catch (error) {
    throw new Error(
      `Failed to read ${label}[${index}]: ${formatUnknownErrorForMessage(error)}`,
    );
  }
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

    let toBase58Candidate: unknown;
    try {
      toBase58Candidate = (value as { toBase58?: unknown }).toBase58;
    } catch (error) {
      return {
        address: undefined,
        error: `failed to read toBase58() method (${formatUnknownErrorForMessage(error)})`,
      };
    }
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
  const entryCount = getArrayLengthOrThrow(values, 'address list');

  for (let index = 0; index < entryCount; index += 1) {
    let value: unknown;
    try {
      value = values[index];
    } catch {
      invalidEntries += 1;
      continue;
    }
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
  const memberCount = getArrayLengthOrThrow(members, 'multisig members');

  for (let index = 0; index < memberCount; index += 1) {
    let member: unknown;
    try {
      member = members[index];
    } catch {
      invalidEntries += 1;
      continue;
    }

    if (!member || typeof member !== 'object') {
      invalidEntries += 1;
      continue;
    }

    const memberRecord = member as { key?: unknown; permissions?: unknown };
    let memberKeyValue: unknown;
    try {
      memberKeyValue = memberRecord.key;
    } catch {
      invalidEntries += 1;
      continue;
    }
    const normalizedMemberKey = normalizeSquadsAddressValue(memberKeyValue);
    if (!normalizedMemberKey.address) {
      invalidEntries += 1;
      continue;
    }

    let permissionsValue: unknown;
    try {
      permissionsValue = memberRecord.permissions;
    } catch {
      permissionsValue = null;
    }
    parsedMembers.push({
      key: normalizedMemberKey.address,
      permissions: permissionsValue ?? null,
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

  let logEntryCount: number;
  try {
    logEntryCount = getArrayLengthOrThrow(value, 'vote log entries');
  } catch {
    return undefined;
  }

  const logEntries: string[] = [];
  for (let index = 0; index < logEntryCount; index += 1) {
    let entry: unknown;
    try {
      entry = value[index];
    } catch {
      continue;
    }
    if (typeof entry === 'string') {
      logEntries.push(entry);
    }
  }

  if (logEntries.length === 0) {
    return undefined;
  }

  return parseSquadsProposalVoteErrorText(logEntries.join('\n'));
}

function getRecordFieldValue(
  record: Record<string, unknown>,
  fieldName: string,
): unknown {
  try {
    return record[fieldName];
  } catch {
    return undefined;
  }
}

function getRecordKeys(record: Record<string, unknown>): string[] {
  try {
    return Object.keys(record);
  } catch {
    return [];
  }
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
      const maybeLogs = getRecordFieldValue(currentRecord, logField);
      const parsedError =
        parseSquadsProposalVoteErrorFromUnknownLogs(maybeLogs);
      if (parsedError) return parsedError;
    }

    const messageValue = getRecordFieldValue(currentRecord, 'message');
    if (typeof messageValue === 'string') {
      const parsedError = parseSquadsProposalVoteErrorText(messageValue);
      if (parsedError) return parsedError;
    }

    for (const field of SQUADS_ERROR_STRING_FIELDS) {
      const value = getRecordFieldValue(currentRecord, field);
      if (typeof value !== 'string') continue;
      const parsedError = parseSquadsProposalVoteErrorText(value);
      if (parsedError) return parsedError;
    }

    for (const field of SQUADS_ERROR_STRING_ARRAY_FIELDS) {
      const value = getRecordFieldValue(currentRecord, field);
      const parsedError = parseSquadsProposalVoteErrorFromUnknownLogs(value);
      if (parsedError) return parsedError;
    }

    for (const key of getRecordKeys(currentRecord)) {
      const nestedValue = getRecordFieldValue(currentRecord, key);
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
    let toStringCandidate: unknown;
    try {
      toStringCandidate = (value as { toString?: unknown }).toString;
    } catch {
      return {
        parsedValue: Number.NaN,
        displayValue: '[unstringifiable value]',
      };
    }

    if (typeof toStringCandidate !== 'function') {
      let objectTagValue: string;
      try {
        objectTagValue = Object.prototype.toString.call(value);
      } catch {
        objectTagValue = '[unstringifiable value]';
      }
      return {
        parsedValue: Number.NaN,
        displayValue: objectTagValue,
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
  mpp: unknown,
  svmProviderOverride?: unknown,
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
  mpp: unknown,
  svmProviderOverride?: unknown,
): SquadAndProvider {
  const { vault, multisigPda, programId } =
    getSquadsKeysForResolvedChain(chain);
  const svmProvider =
    typeof svmProviderOverride === 'undefined'
      ? getSolanaWeb3ProviderForChain(mpp, chain)
      : validateSolanaWeb3ProviderForChain(svmProviderOverride, chain);

  return { chain, svmProvider, vault, multisigPda, programId };
}

function getSolanaWeb3ProviderForChain(
  mpp: unknown,
  chain: SquadsChainName,
): SolanaWeb3Provider {
  let getSolanaWeb3ProviderValue: unknown;
  try {
    getSolanaWeb3ProviderValue = (mpp as { getSolanaWeb3Provider?: unknown })
      .getSolanaWeb3Provider;
  } catch (error) {
    throw new Error(
      `Failed to read getSolanaWeb3Provider for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof getSolanaWeb3ProviderValue === 'function',
    `Invalid multiprovider for ${chain}: expected getSolanaWeb3Provider function, got ${getUnknownValueTypeName(getSolanaWeb3ProviderValue)}`,
  );

  let providerValue: unknown;
  try {
    providerValue = getSolanaWeb3ProviderValue.call(mpp, chain);
  } catch (error) {
    throw new Error(
      `Failed to resolve solana provider for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  return validateSolanaWeb3ProviderForChain(providerValue, chain);
}

function validateSolanaWeb3ProviderForChain(
  providerValue: unknown,
  chain: SquadsChainName,
): SolanaWeb3Provider {
  let thenValue: unknown;
  try {
    thenValue = (providerValue as { then?: unknown } | null | undefined)?.then;
  } catch (error) {
    throw new Error(
      `Failed to inspect solana provider for ${chain}: failed to read promise-like then field (${formatUnknownErrorForMessage(error)})`,
    );
  }

  assert(
    typeof thenValue !== 'function',
    `Invalid solana provider for ${chain}: expected synchronous provider, got promise-like value`,
  );

  let getAccountInfoValue: unknown;
  try {
    getAccountInfoValue = (providerValue as { getAccountInfo?: unknown })
      .getAccountInfo;
  } catch (error) {
    throw new Error(
      `Failed to read getAccountInfo for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof getAccountInfoValue === 'function',
    `Invalid solana provider for ${chain}: expected getAccountInfo function, got ${getUnknownValueTypeName(getAccountInfoValue)}`,
  );

  return providerValue as SolanaWeb3Provider;
}

function getPendingProposalNativeTokenMetadataForChain(
  mpp: unknown,
  chain: SquadsChainName,
): { decimals: number; symbol: string } {
  let getChainMetadataValue: unknown;
  try {
    getChainMetadataValue = (mpp as { getChainMetadata?: unknown })
      .getChainMetadata;
  } catch (error) {
    throw new Error(
      `Failed to read getChainMetadata accessor for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof getChainMetadataValue === 'function',
    `Invalid multi-provider for ${chain}: expected getChainMetadata function, got ${getUnknownValueTypeName(getChainMetadataValue)}`,
  );

  let chainMetadata: unknown;
  try {
    chainMetadata = getChainMetadataValue.call(mpp, chain);
  } catch (error) {
    throw new Error(
      `Failed to resolve chain metadata for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof chainMetadata === 'object' && chainMetadata !== null,
    `Malformed chain metadata for ${chain}: expected object, got ${getUnknownValueTypeName(chainMetadata)}`,
  );

  let nativeToken: unknown;
  try {
    nativeToken = (chainMetadata as { nativeToken?: unknown }).nativeToken;
  } catch (error) {
    throw new Error(
      `Failed to read native token metadata for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof nativeToken === 'object' && nativeToken !== null,
    `Malformed native token metadata for ${chain}: expected object, got ${getUnknownValueTypeName(nativeToken)}`,
  );

  let decimals: unknown;
  try {
    decimals = (nativeToken as { decimals?: unknown }).decimals;
  } catch (error) {
    throw new Error(
      `Failed to read native token decimals for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof decimals === 'number' &&
      Number.isSafeInteger(decimals) &&
      decimals >= 0,
    `Malformed native token decimals for ${chain}: expected non-negative safe integer, got ${getUnknownValueTypeName(decimals)}`,
  );

  let symbolValue: unknown;
  try {
    symbolValue = (nativeToken as { symbol?: unknown }).symbol;
  } catch (error) {
    throw new Error(
      `Failed to read native token symbol for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof symbolValue === 'string',
    `Malformed native token symbol for ${chain}: expected non-empty string, got ${getUnknownValueTypeName(symbolValue)}`,
  );

  const symbol = symbolValue.trim();
  assert(
    symbol.length > 0,
    `Malformed native token symbol for ${chain}: expected non-empty string, got empty`,
  );

  return { decimals, symbol };
}

function getSignerPublicKeyForChain(
  signerAdapter: unknown,
  chain: SquadsChainName,
): PublicKey {
  let publicKeyValue: unknown;
  try {
    publicKeyValue = (signerAdapter as { publicKey?: unknown }).publicKey;
  } catch (error) {
    throw new Error(
      `Failed to read signer publicKey for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof publicKeyValue === 'function',
    `Invalid signer adapter for ${chain}: expected publicKey function, got ${getUnknownValueTypeName(publicKeyValue)}`,
  );

  let signerPublicKey: unknown;
  try {
    signerPublicKey = publicKeyValue.call(signerAdapter);
  } catch (error) {
    throw new Error(
      `Failed to resolve signer public key for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  let signerPublicKeyThenValue: unknown;
  try {
    signerPublicKeyThenValue = (
      signerPublicKey as { then?: unknown } | null | undefined
    )?.then;
  } catch (error) {
    throw new Error(
      `Failed to inspect signer public key for ${chain}: failed to read promise-like then field (${formatUnknownErrorForMessage(error)})`,
    );
  }

  assert(
    typeof signerPublicKeyThenValue !== 'function',
    `Invalid signer public key for ${chain}: expected synchronous PublicKey, got promise-like value`,
  );

  assert(
    signerPublicKey instanceof PublicKey,
    `Invalid signer public key for ${chain}: expected PublicKey, got ${getUnknownValueTypeName(signerPublicKey)}`,
  );

  return signerPublicKey;
}

function getSignerBuildAndSendTransactionForChain(
  signerAdapter: unknown,
  chain: SquadsChainName,
): SvmMultiProtocolSignerAdapter['buildAndSendTransaction'] {
  let buildAndSendTransactionValue: unknown;
  try {
    buildAndSendTransactionValue = (
      signerAdapter as { buildAndSendTransaction?: unknown }
    ).buildAndSendTransaction;
  } catch (error) {
    throw new Error(
      `Failed to read signer buildAndSendTransaction for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof buildAndSendTransactionValue === 'function',
    `Invalid signer adapter for ${chain}: expected buildAndSendTransaction function, got ${getUnknownValueTypeName(buildAndSendTransactionValue)}`,
  );

  return buildAndSendTransactionValue as SvmMultiProtocolSignerAdapter['buildAndSendTransaction'];
}

export async function getSquadProposal(
  chain: unknown,
  mpp: unknown,
  transactionIndex: unknown,
  svmProviderOverride?: unknown,
): Promise<
  | {
      proposal: accounts.Proposal;
      multisig: accounts.Multisig;
      proposalPda: PublicKey;
    }
  | undefined
> {
  const normalizedChain = resolveSquadsChainName(chain);
  const normalizedTransactionIndex = assertValidTransactionIndexInput(
    transactionIndex,
    normalizedChain,
  );

  try {
    const proposalAccountData = await getSquadProposalAccountForResolvedChain(
      normalizedChain,
      mpp,
      normalizedTransactionIndex,
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
      `Failed to fetch proposal ${normalizedTransactionIndex} on ${normalizedChain}: ${errorText}`,
    );
    return undefined;
  }
}

export async function getSquadProposalAccount(
  chain: unknown,
  mpp: unknown,
  transactionIndex: unknown,
  svmProviderOverride?: unknown,
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
  const normalizedTransactionIndex = assertValidTransactionIndexInput(
    transactionIndex,
    normalizedChain,
  );

  const proposalAccountData = await getSquadProposalAccountForResolvedChain(
    normalizedChain,
    mpp,
    normalizedTransactionIndex,
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
  mpp: unknown,
  transactionIndex: number,
  svmProviderOverride?: unknown,
): Promise<SquadProposalAccountWithProvider | undefined> {
  try {
    const { svmProvider, multisigPda, programId } =
      getSquadAndProviderForResolvedChain(chain, mpp, svmProviderOverride);
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
  mpp: unknown,
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
        const { decimals, symbol: nativeTokenSymbol } =
          getPendingProposalNativeTokenMetadataForChain(mpp, chain);
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
  transactionIndex: unknown,
  staleTransactionIndex: unknown,
): boolean {
  const normalizedStatusKind = normalizeStatusKind(statusKind);
  const normalizedTransactionIndex = assertNonNegativeSafeInteger(
    transactionIndex,
    'transaction index',
  );
  const normalizedStaleTransactionIndex = assertNonNegativeSafeInteger(
    staleTransactionIndex,
    'stale transaction index',
  );

  return (
    normalizedTransactionIndex < normalizedStaleTransactionIndex &&
    !isTerminalSquadsProposalStatus(normalizedStatusKind)
  );
}

export function shouldTrackPendingSquadsProposal(
  statusKind: unknown,
  transactionIndex: unknown,
  staleTransactionIndex: unknown,
  rejections: unknown,
): boolean {
  const normalizedRejections = assertNonNegativeSafeInteger(
    rejections,
    'rejections',
  );
  return (
    normalizedRejections === 0 &&
    !isTerminalSquadsProposalStatus(statusKind) &&
    !isStaleSquadsProposal(statusKind, transactionIndex, staleTransactionIndex)
  );
}

export function getSquadTxStatus(
  statusKind: unknown,
  approvals: unknown,
  threshold: unknown,
  transactionIndex: unknown,
  staleTransactionIndex: unknown,
): SquadTxStatus {
  const normalizedStatusKind = normalizeStatusKind(statusKind);
  const normalizedApprovals = assertNonNegativeSafeInteger(
    approvals,
    'approvals',
  );
  const normalizedThreshold = assertPositiveSafeInteger(threshold, 'threshold');
  const normalizedTransactionIndex = assertNonNegativeSafeInteger(
    transactionIndex,
    'transaction index',
  );
  const normalizedStaleTransactionIndex = assertNonNegativeSafeInteger(
    staleTransactionIndex,
    'stale transaction index',
  );

  if (
    isStaleSquadsProposal(
      normalizedStatusKind,
      normalizedTransactionIndex,
      normalizedStaleTransactionIndex,
    )
  ) {
    return SquadTxStatus.STALE;
  }

  switch (normalizedStatusKind) {
    case SquadsProposalStatus.Draft:
      return SquadTxStatus.DRAFT;
    case SquadsProposalStatus.Active:
      return normalizedApprovals >= normalizedThreshold
        ? SquadTxStatus.APPROVED
        : normalizedThreshold - normalizedApprovals === 1
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

function formatSafeIntegerInputValue(value: unknown): string {
  return typeof value === 'number'
    ? String(value)
    : getUnknownValueTypeName(value);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): number {
  assert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    `Expected ${label} to be a non-negative safe integer, got ${formatSafeIntegerInputValue(value)}`,
  );
  return value;
}

function assertPositiveSafeInteger(value: unknown, label: string): number {
  assert(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    `Expected ${label} to be a positive safe integer, got ${formatSafeIntegerInputValue(value)}`,
  );
  return value;
}

export function getMinimumProposalIndexToCheck(
  currentTransactionIndex: unknown,
  lookbackCount: unknown = SQUADS_PROPOSAL_LOOKBACK_COUNT,
): number {
  const normalizedCurrentTransactionIndex = assertNonNegativeSafeInteger(
    currentTransactionIndex,
    'current transaction index',
  );
  const normalizedLookbackCount = assertNonNegativeSafeInteger(
    lookbackCount,
    'lookback count',
  );

  return Math.max(
    0,
    normalizedCurrentTransactionIndex - normalizedLookbackCount,
  );
}

export function parseSquadProposal(proposal: unknown): ParsedSquadProposal {
  const proposalRecord = getObjectRecord(proposal, 'Squads proposal');
  const approvals = getProposalVoteCount(proposalRecord, 'approved');
  const rejections = getProposalVoteCount(proposalRecord, 'rejected');
  const cancellations = getProposalVoteCount(proposalRecord, 'cancelled');
  const { statusKind, rawStatusTimestamp } =
    getProposalStatusMetadata(proposalRecord);
  const transactionIndex = parseSquadProposalTransactionIndex(proposalRecord);
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

export function parseSquadProposalTransactionIndex(proposal: unknown): number {
  const proposalRecord = getObjectRecord(proposal, 'Squads proposal');
  const transactionIndex = getRecordFieldOrThrow(
    proposalRecord,
    'transactionIndex',
    'Squads transaction index',
  );
  return toSafeInteger(transactionIndex, 'transaction index', {
    nonNegative: true,
  });
}

function getProposalStatusMetadata(proposal: Record<string, unknown>): {
  statusKind: string;
  rawStatusTimestamp: unknown;
} {
  const status = getRecordFieldOrThrow(
    proposal,
    'status',
    'Squads proposal status',
  );
  assert(
    status && typeof status === 'object',
    'Squads proposal status must be an object',
  );

  const statusRecord = status as Record<string, unknown>;
  const statusKind = getRecordFieldOrThrow(
    statusRecord,
    '__kind',
    'Squads proposal status kind',
  );
  const normalizedStatusKind = normalizeStatusKind(
    statusKind,
    'Squads proposal status kind must be a string',
    'Squads proposal status kind must be a non-empty string',
  );
  const rawStatusTimestamp = getRecordFieldOrThrow(
    statusRecord,
    'timestamp',
    'Squads proposal status timestamp',
  );

  return {
    statusKind: normalizedStatusKind,
    rawStatusTimestamp,
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
  const fieldValue = getRecordFieldOrThrow(
    proposal,
    fieldName,
    `Squads proposal ${fieldName} votes`,
  );
  assert(
    Array.isArray(fieldValue),
    `Squads proposal ${fieldName} votes must be an array`,
  );
  return getArrayLengthOrThrow(
    fieldValue,
    `Squads proposal ${fieldName} votes`,
  );
}

export function parseSquadMultisig(
  multisig: unknown,
  fieldPrefix = 'multisig',
): ParsedSquadMultisig {
  const multisigRecord = getObjectRecord(multisig, `Squads ${fieldPrefix}`);
  const threshold = toSafeInteger(
    getRecordFieldOrThrow(
      multisigRecord,
      'threshold',
      `Squads ${fieldPrefix} threshold`,
    ),
    `${fieldPrefix} threshold`,
    {
      positive: true,
    },
  );
  const currentTransactionIndex = toSafeInteger(
    getRecordFieldOrThrow(
      multisigRecord,
      'transactionIndex',
      `Squads ${fieldPrefix} transaction index`,
    ),
    `${fieldPrefix} transaction index`,
    { nonNegative: true },
  );
  const staleTransactionIndex = toSafeInteger(
    getRecordFieldOrThrow(
      multisigRecord,
      'staleTransactionIndex',
      `Squads ${fieldPrefix} stale transaction index`,
    ),
    `${fieldPrefix} stale transaction index`,
    { nonNegative: true },
  );
  const timeLock = toSafeInteger(
    getRecordFieldOrThrow(
      multisigRecord,
      'timeLock',
      `Squads ${fieldPrefix} timelock`,
    ),
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
  const members = getRecordFieldOrThrow(
    multisig,
    'members',
    `Squads ${fieldPrefix} members`,
  );
  if (typeof members === 'undefined') {
    return undefined;
  }

  assert(
    Array.isArray(members),
    `Squads ${fieldPrefix} members must be an array when provided`,
  );

  const memberCount = getArrayLengthOrThrow(
    members,
    `Squads ${fieldPrefix} members`,
  );
  for (let index = 0; index < memberCount; index += 1) {
    const member: unknown = getArrayElementOrThrow(
      members,
      index,
      `Squads ${fieldPrefix} members`,
    );
    assert(
      member && typeof member === 'object',
      `Squads ${fieldPrefix} members[${index}] must be an object`,
    );
    const memberRecord = member as Record<string, unknown>;
    const memberKey = getRecordFieldOrThrow(
      memberRecord,
      'key',
      `Squads ${fieldPrefix} members[${index}] key`,
    );
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

  return memberCount;
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
  mpp: unknown,
  svmProviderOverride?: unknown,
): Promise<bigint> {
  const { svmProvider, multisigPda, programId } =
    getSquadAndProviderForResolvedChain(chain, mpp, svmProviderOverride);
  const multisigAccountInfo = await getMultisigAccountInfoForNextIndex(
    chain,
    svmProvider,
    multisigPda,
  );
  warnOnUnexpectedMultisigAccountOwner(chain, multisigAccountInfo, programId);

  const squadsProvider = toSquadsProvider(svmProvider);

  const multisig = await accounts.Multisig.fromAccountAddress(
    squadsProvider,
    multisigPda,
  );

  const parsedMultisig = parseSquadMultisig(multisig, `${chain} multisig`);
  const currentIndex = BigInt(parsedMultisig.currentTransactionIndex);
  const nextIndex = currentIndex + 1n;

  return nextIndex;
}

async function getMultisigAccountInfoForNextIndex(
  chain: SquadsChainName,
  svmProvider: SolanaWeb3Provider,
  multisigPda: PublicKey,
): Promise<unknown> {
  let getAccountInfoValue: unknown;
  try {
    getAccountInfoValue = (svmProvider as { getAccountInfo?: unknown })
      .getAccountInfo;
  } catch (error) {
    throw new Error(
      `Failed to read getAccountInfo for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof getAccountInfoValue === 'function',
    `Invalid solana provider for ${chain}: expected getAccountInfo function, got ${getUnknownValueTypeName(getAccountInfoValue)}`,
  );

  try {
    return await getAccountInfoValue.call(svmProvider, multisigPda);
  } catch (error) {
    throw new Error(
      `Failed to fetch multisig account ${multisigPda.toBase58()} on ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }
}

function warnOnUnexpectedMultisigAccountOwner(
  chain: SquadsChainName,
  accountInfo: unknown,
  expectedProgramId: PublicKey,
): void {
  if (!accountInfo || typeof accountInfo !== 'object') {
    return;
  }

  let ownerValue: unknown;
  try {
    ownerValue = (accountInfo as { owner?: unknown }).owner;
  } catch (error) {
    rootLogger.warn(
      `Failed to read multisig account owner on ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
    return;
  }

  if (!(ownerValue instanceof PublicKey)) {
    rootLogger.warn(
      `Skipping multisig owner validation on ${chain}: expected owner PublicKey, got ${getUnknownValueTypeName(ownerValue)}`,
    );
    return;
  }

  if (!ownerValue.equals(expectedProgramId)) {
    rootLogger.warn(
      `WARNING: Multisig account owner (${ownerValue.toBase58()}) does not match expected program ID (${expectedProgramId.toBase58()})`,
    );
  }
}

function assertValidBigintTransactionIndex(
  transactionIndex: unknown,
  chain: unknown,
): bigint {
  const chainLabel =
    typeof chain === 'string' && chain.trim().length > 0
      ? chain.trim()
      : 'unknown chain';
  assert(
    typeof transactionIndex === 'bigint',
    `Expected transaction index to be a bigint for ${chainLabel}, got ${getUnknownValueTypeName(transactionIndex)}`,
  );
  assert(
    transactionIndex >= 0n,
    `Expected transaction index to be a non-negative bigint for ${chainLabel}, got ${transactionIndex.toString()}`,
  );

  return transactionIndex;
}

function assertPublicKeyValue(value: unknown, label: string): PublicKey {
  assert(
    value instanceof PublicKey,
    `Expected ${label} to be a PublicKey, got ${getUnknownValueTypeName(value)}`,
  );
  return value;
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

function normalizeProposalInstructionsForBuild(
  chain: SquadsChainName,
  ixs: unknown,
): TransactionInstruction[] {
  assert(
    Array.isArray(ixs),
    `Expected proposal instructions for ${chain} to be an array, got ${getUnknownValueTypeName(ixs)}`,
  );

  const normalizedInstructions: TransactionInstruction[] = [];
  const instructionCount = getArrayLengthOrThrow(
    ixs,
    `proposal instructions for ${chain}`,
  );
  for (
    let instructionIndex = 0;
    instructionIndex < instructionCount;
    instructionIndex += 1
  ) {
    const instruction = getArrayElementOrThrow(
      ixs,
      instructionIndex,
      `proposal instructions for ${chain}`,
    );
    assert(
      instruction instanceof TransactionInstruction,
      `Expected proposal instructions for ${chain}[${instructionIndex}] to be a TransactionInstruction, got ${getUnknownValueTypeName(instruction)}`,
    );
    normalizedInstructions.push(instruction);
  }

  return normalizedInstructions;
}

function normalizeProposalMemoForBuild(
  chain: SquadsChainName,
  memo: unknown,
): string | undefined {
  if (memo === undefined || memo === null) {
    return undefined;
  }

  assert(
    typeof memo === 'string',
    `Expected proposal memo for ${chain} to be a string, got ${getUnknownValueTypeName(memo)}`,
  );

  const normalizedMemo = memo.trim();
  return normalizedMemo.length > 0 ? normalizedMemo : undefined;
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
  mpp: unknown,
  ixs: unknown,
  creator: unknown,
  memo?: unknown,
  svmProviderOverride?: unknown,
): Promise<{
  instructions: TransactionInstruction[];
  transactionIndex: bigint;
}> {
  const normalizedChain = resolveSquadsChainName(chain);
  const normalizedCreator = assertPublicKeyValue(
    creator,
    `proposal creator for ${normalizedChain}`,
  );
  const normalizedInstructions = normalizeProposalInstructionsForBuild(
    normalizedChain,
    ixs,
  );
  const normalizedMemo = normalizeProposalMemoForBuild(normalizedChain, memo);
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
    normalizedInstructions,
    blockhash,
  );

  const vaultTxIx = createVaultTransactionInstruction(
    multisigPda,
    transactionIndex,
    normalizedCreator,
    0,
    transactionMessage,
    programId,
    normalizedMemo,
  );

  const proposalIx = createProposalInstruction(
    multisigPda,
    transactionIndex,
    normalizedCreator,
    programId,
  );

  return {
    instructions: [vaultTxIx, proposalIx],
    transactionIndex,
  };
}

export async function buildSquadsProposalRejection(
  chain: unknown,
  mpp: unknown,
  transactionIndex: unknown,
  member: unknown,
  svmProviderOverride?: unknown,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const normalizedChain = resolveSquadsChainName(chain);
  const normalizedTransactionIndex = assertValidBigintTransactionIndex(
    transactionIndex,
    normalizedChain,
  );
  const normalizedMember = assertPublicKeyValue(
    member,
    `proposal rejection member for ${normalizedChain}`,
  );
  const { multisigPda, programId } = getSquadAndProviderForResolvedChain(
    normalizedChain,
    mpp,
    svmProviderOverride,
  );

  const rejectIx = instructions.proposalReject({
    multisigPda,
    transactionIndex: normalizedTransactionIndex,
    member: normalizedMember,
    programId,
  });

  return {
    instruction: rejectIx,
  };
}

export async function buildSquadsProposalCancellation(
  chain: unknown,
  mpp: unknown,
  transactionIndex: unknown,
  member: unknown,
  svmProviderOverride?: unknown,
): Promise<{
  instruction: TransactionInstruction;
}> {
  const normalizedChain = resolveSquadsChainName(chain);
  const normalizedTransactionIndex = assertValidBigintTransactionIndex(
    transactionIndex,
    normalizedChain,
  );
  const normalizedMember = assertPublicKeyValue(
    member,
    `proposal cancellation member for ${normalizedChain}`,
  );
  const { multisigPda, programId } = getSquadAndProviderForResolvedChain(
    normalizedChain,
    mpp,
    svmProviderOverride,
  );

  const cancelIx = createProposalCancelInstruction(
    multisigPda,
    normalizedTransactionIndex,
    normalizedMember,
    programId,
  );

  return {
    instruction: cancelIx,
  };
}

export async function submitProposalToSquads(
  chain: unknown,
  vaultInstructions: unknown,
  mpp: unknown,
  signerAdapter: unknown,
  memo?: unknown,
): Promise<void> {
  try {
    const normalizedChain = resolveSquadsChainName(chain);
    const normalizedVaultInstructions = normalizeProposalInstructionsForBuild(
      normalizedChain,
      vaultInstructions,
    );
    const normalizedMemo = normalizeProposalMemoForBuild(normalizedChain, memo);
    const creatorPublicKey = getSignerPublicKeyForChain(
      signerAdapter,
      normalizedChain,
    );
    const buildAndSendTransaction = getSignerBuildAndSendTransactionForChain(
      signerAdapter,
      normalizedChain,
    );
    const { svmProvider, multisigPda, programId } =
      getSquadAndProviderForResolvedChain(normalizedChain, mpp);

    const { instructions: proposalInstructions, transactionIndex } =
      await buildSquadsVaultTransactionProposal(
        normalizedChain,
        mpp,
        normalizedVaultInstructions,
        creatorPublicKey,
        normalizedMemo,
        svmProvider,
      );

    const createSignature = await buildAndSendTransaction.call(
      signerAdapter,
      proposalInstructions,
    );

    rootLogger.info(`Proposal created: ${createSignature}`);
    rootLogger.info(`Transaction index: ${transactionIndex}`);

    const approveIx = instructions.proposalApprove({
      multisigPda,
      transactionIndex,
      member: creatorPublicKey,
      programId,
    });

    const approveSignature = await buildAndSendTransaction.call(signerAdapter, [
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

function assertIsDiscriminatorSource(
  accountData: unknown,
): asserts accountData is Uint8Array {
  assert(
    accountData instanceof Uint8Array,
    `Expected account data to be a Uint8Array, got ${getUnknownValueTypeName(accountData)}`,
  );
}

function hasMatchingDiscriminator(
  accountData: Uint8Array,
  expectedDiscriminator: Uint8Array,
): boolean {
  const discriminator = accountData.subarray(
    0,
    SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  );
  if (discriminator.length !== expectedDiscriminator.length) {
    return false;
  }

  for (let index = 0; index < expectedDiscriminator.length; index += 1) {
    if (discriminator[index] !== expectedDiscriminator[index]) {
      return false;
    }
  }

  return true;
}

function readTransactionAccountDataForType(
  chain: SquadsChainName,
  accountInfo: { data?: unknown },
): Uint8Array {
  let dataValue: unknown;
  try {
    dataValue = accountInfo.data;
  } catch (error) {
    throw new Error(
      `Failed to read transaction account data on ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    dataValue instanceof Uint8Array,
    `Malformed transaction account data on ${chain}: expected Uint8Array, got ${getUnknownValueTypeName(dataValue)}`,
  );

  return dataValue;
}

async function getTransactionAccountInfoForType(
  chain: SquadsChainName,
  svmProvider: SolanaWeb3Provider,
  transactionPda: PublicKey,
): Promise<unknown> {
  let getAccountInfoValue: unknown;
  try {
    getAccountInfoValue = (svmProvider as { getAccountInfo?: unknown })
      .getAccountInfo;
  } catch (error) {
    throw new Error(
      `Failed to read getAccountInfo for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof getAccountInfoValue === 'function',
    `Invalid solana provider for ${chain}: expected getAccountInfo function, got ${getUnknownValueTypeName(getAccountInfoValue)}`,
  );

  try {
    return await getAccountInfoValue.call(svmProvider, transactionPda);
  } catch (error) {
    throw new Error(
      `Failed to fetch transaction account ${transactionPda.toBase58()} on ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }
}

export function isVaultTransaction(accountData: unknown): boolean {
  assertIsDiscriminatorSource(accountData);
  return hasMatchingDiscriminator(
    accountData,
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
  );
}

export function isConfigTransaction(accountData: unknown): boolean {
  assertIsDiscriminatorSource(accountData);
  return hasMatchingDiscriminator(
    accountData,
    SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
  );
}

export async function getTransactionType(
  chain: unknown,
  mpp: unknown,
  transactionIndex: unknown,
  svmProviderOverride?: unknown,
): Promise<SquadsAccountType> {
  const normalizedChain = resolveSquadsChainName(chain);
  const normalizedTransactionIndex = assertValidTransactionIndexInput(
    transactionIndex,
    normalizedChain,
  );
  const { svmProvider, multisigPda, programId } =
    getSquadAndProviderForResolvedChain(
      normalizedChain,
      mpp,
      svmProviderOverride,
    );

  const [transactionPda] = getTransactionPda({
    multisigPda,
    index: BigInt(normalizedTransactionIndex),
    programId,
  });

  const accountInfo = await getTransactionAccountInfoForType(
    normalizedChain,
    svmProvider,
    transactionPda,
  );
  if (!accountInfo) {
    throw new Error(
      `Transaction account not found at ${transactionPda.toBase58()}`,
    );
  }

  const accountData = readTransactionAccountDataForType(
    normalizedChain,
    accountInfo as { data?: unknown },
  );

  if (isVaultTransaction(accountData)) {
    return SquadsAccountType.VAULT;
  } else if (isConfigTransaction(accountData)) {
    return SquadsAccountType.CONFIG;
  } else {
    const discriminator = accountData.subarray(
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
  mpp: unknown,
  transactionIndex: unknown,
  signerAdapter: unknown,
): Promise<void> {
  const normalizedChain = resolveSquadsChainName(chain);
  const normalizedTransactionIndex = assertValidTransactionIndexInput(
    transactionIndex,
    normalizedChain,
  );
  const buildAndSendTransaction = getSignerBuildAndSendTransactionForChain(
    signerAdapter,
    normalizedChain,
  );
  const executorPublicKey = getSignerPublicKeyForChain(
    signerAdapter,
    normalizedChain,
  );
  const { svmProvider, multisigPda, programId } =
    getSquadAndProviderForResolvedChain(normalizedChain, mpp);

  const proposalData = await getSquadProposal(
    normalizedChain,
    mpp,
    normalizedTransactionIndex,
    svmProvider,
  );
  if (!proposalData) {
    throw new Error(
      `Failed to fetch proposal ${normalizedTransactionIndex} on ${normalizedChain}`,
    );
  }

  const { proposal } = proposalData;
  const parsedProposal = parseSquadProposal(proposal);
  if (parsedProposal.status !== SquadsProposalStatus.Approved) {
    throw new Error(
      `Proposal ${normalizedTransactionIndex} on ${normalizedChain} is not approved (status: ${parsedProposal.status})`,
    );
  }

  const txType = await getTransactionType(
    normalizedChain,
    mpp,
    normalizedTransactionIndex,
    svmProvider,
  );
  rootLogger.info(
    `Executing ${txType} proposal ${normalizedTransactionIndex} on ${normalizedChain}`,
  );

  try {
    let instruction: TransactionInstruction;

    if (txType === SquadsAccountType.VAULT) {
      const { instruction: vaultInstruction, lookupTableAccounts } =
        await instructions.vaultTransactionExecute({
          connection: svmProvider,
          multisigPda,
          transactionIndex: BigInt(normalizedTransactionIndex),
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
        transactionIndex: BigInt(normalizedTransactionIndex),
        member: executorPublicKey,
        programId,
      });
    }

    const signature = await buildAndSendTransaction.call(signerAdapter, [
      instruction,
    ]);

    rootLogger.info(
      `Executed proposal ${normalizedTransactionIndex} on ${normalizedChain}: ${signature}`,
    );
  } catch (error) {
    rootLogger.error(
      `Error executing proposal ${normalizedTransactionIndex} on ${normalizedChain}: ${formatUnknownErrorForMessage(error)}`,
    );
    throw error;
  }
}

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
import {
  inspectArrayValue,
  inspectInstanceOf,
  inspectObjectKeys,
  inspectPropertyValue,
  inspectPromiseLikeThenValue,
} from './inspection.js';
import { toSquadsProvider } from './provider.js';
import { assertValidTransactionIndexInput } from './validation.js';
export { assertValidTransactionIndexInput } from './validation.js';
export { inspectPromiseLikeThenValue } from './inspection.js';

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
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const ARRAY_FROM = Array.from;
const ARRAY_MAP = Array.prototype.map;
const ARRAY_FILTER = Array.prototype.filter;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_PUSH = Array.prototype.push;
const ARRAY_SORT = Array.prototype.sort;
const ARRAY_INCLUDES = Array.prototype.includes;
const ARRAY_SOME = Array.prototype.some;
const BIGINT_FUNCTION = BigInt as (
  value: string | number | bigint | boolean,
) => bigint;
const BOOLEAN_FUNCTION = Boolean;
const PROMISE_ALL = Promise.all.bind(Promise) as <Value>(
  values: readonly (Value | PromiseLike<Value>)[],
) => Promise<Value[]>;
const MATH_MAX = Math.max;
const NUMBER_FUNCTION = Number;
const NUMBER_NAN = 0 / 0;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_IS_FINITE = Number.isFinite;
const DATE_CONSTRUCTOR = Date;
const DATE_TO_DATE_STRING = Date.prototype.toDateString as (
  this: Date,
) => string;
const OBJECT_PROTOTYPE_TO_STRING = Object.prototype.toString as (
  this: unknown,
) => string;
const STRING_FUNCTION = String;
const STRING_INCLUDES = String.prototype.includes;
const STRING_TRIM = String.prototype.trim;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_SLICE = String.prototype.slice as (
  this: string,
  start?: number,
  end?: number,
) => string;
const STRING_LOCALE_COMPARE = String.prototype.localeCompare as (
  this: string,
  compareString: string,
) => number;
const UINT8_ARRAY_SUBARRAY = Uint8Array.prototype.subarray as (
  this: Uint8Array,
  begin?: number,
  end?: number,
) => Uint8Array;
const STRING_SPLIT = String.prototype.split as (
  this: string,
  separator: string | RegExp,
  limit?: number,
) => string[];
const STRING_REPLACE = String.prototype.replace as (
  this: string,
  searchValue: string | RegExp,
  replaceValue: string,
) => string;
const SAFE_INTEGER_DECIMAL_PATTERN = /^-?\d+$/;
const LIKELY_MISSING_SQUADS_ACCOUNT_ERROR_PATTERNS = [
  'account does not exist',
  'account not found',
  'could not find account',
  'failed to find account',
] as const;

function tokenizeFieldName(fieldName: string): string[] {
  const normalizedFieldName = stringToLowerCase(
    stringReplaceValue(
      stringReplaceValue(fieldName, /([a-z])([A-Z])/g, '$1_$2'),
      /[^a-zA-Z0-9]+/g,
      '_',
    ),
  );
  return arrayFilterValues(
    stringSplitValue(normalizedFieldName, '_'),
    (token) => token.length > 0,
  );
}

const UNREADABLE_VALUE_TYPE = '[unreadable value type]';

function setHasValue<Value>(set: Set<Value>, value: Value): boolean {
  return SET_HAS.call(set, value);
}

function setAddValue<Value>(set: Set<Value>, value: Value): void {
  SET_ADD.call(set, value);
}

function mapGetValue<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
): Value | undefined {
  return MAP_GET.call(map, key);
}

function mapSetValue<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
): void {
  MAP_SET.call(map, key, value);
}

function arrayFromValue<T>(value: ArrayLike<T>): T[] {
  return ARRAY_FROM(value);
}

function arrayMapValues<Value, Result>(
  values: readonly Value[],
  mapFn: (value: Value, index: number, array: readonly Value[]) => Result,
): Result[] {
  return ARRAY_MAP.call(values, mapFn) as Result[];
}

function arrayFilterValues<Value>(
  values: readonly Value[],
  predicate: (value: Value, index: number, array: readonly Value[]) => boolean,
): Value[] {
  return ARRAY_FILTER.call(values, predicate) as Value[];
}

function arrayJoinValues(
  values: readonly unknown[],
  separator: string,
): string {
  return ARRAY_JOIN.call(values, separator);
}

function arrayPushValue<Value>(values: Value[], value: Value): number {
  return ARRAY_PUSH.call(values, value);
}

function arraySortValues<Value>(
  values: Value[],
  compareFn: (left: Value, right: Value) => number,
): Value[] {
  return ARRAY_SORT.call(values, compareFn) as Value[];
}

function arrayIncludesValue<Value>(
  values: readonly Value[],
  value: Value,
): boolean {
  return ARRAY_INCLUDES.call(values, value);
}

function arraySomeValue<Value>(
  values: readonly Value[],
  predicate: (value: Value, index: number, array: readonly Value[]) => boolean,
): boolean {
  return ARRAY_SOME.call(values, predicate);
}

function numberIsSafeInteger(value: unknown): boolean {
  return NUMBER_IS_SAFE_INTEGER(value);
}

function bigintFromValue(value: string | number | bigint | boolean): bigint {
  return BIGINT_FUNCTION(value);
}

function booleanFromValue(value: unknown): boolean {
  return BOOLEAN_FUNCTION(value);
}

function promiseAllValues<Value>(
  values: readonly (Value | PromiseLike<Value>)[],
): Promise<Value[]> {
  return PROMISE_ALL(values);
}

function numberFromValue(value: unknown): number {
  return NUMBER_FUNCTION(value);
}

function numberNaNValue(): number {
  return NUMBER_NAN;
}

function stringFromValue(value: unknown): string {
  return STRING_FUNCTION(value);
}

function numberIsFinite(value: unknown): boolean {
  return NUMBER_IS_FINITE(value);
}

function numberMax(left: number, right: number): number {
  return MATH_MAX(left, right);
}

function objectPrototypeToString(value: unknown): string {
  return OBJECT_PROTOTYPE_TO_STRING.call(value);
}

function dateFromUnixTimestampSeconds(unixTimestampSeconds: number): Date {
  return new DATE_CONSTRUCTOR(unixTimestampSeconds * 1000);
}

function dateToDateString(value: Date): string {
  return DATE_TO_DATE_STRING.call(value);
}

function stringIncludesValue(value: string, searchValue: string): boolean {
  return STRING_INCLUDES.call(value, searchValue);
}

function stringSplitValue(value: string, separator: string | RegExp): string[] {
  return STRING_SPLIT.call(value, separator) as string[];
}

function stringReplaceValue(
  value: string,
  searchValue: string | RegExp,
  replaceValue: string,
): string {
  return STRING_REPLACE.call(value, searchValue, replaceValue);
}

function stringTrim(value: string): string {
  return STRING_TRIM.call(value);
}

function stringToLowerCase(value: string): string {
  return STRING_TO_LOWER_CASE.call(value);
}

function stringSliceValue(value: string, start?: number, end?: number): string {
  return STRING_SLICE.call(value, start, end);
}

function stringLocaleCompare(left: string, right: string): number {
  return STRING_LOCALE_COMPARE.call(left, right);
}

function uint8ArraySubarray(
  value: Uint8Array,
  begin?: number,
  end?: number,
): Uint8Array {
  return UINT8_ARRAY_SUBARRAY.call(value, begin, end);
}

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const { isArray, readFailed } = inspectArrayValue(value);
  if (readFailed) {
    return UNREADABLE_VALUE_TYPE;
  }

  return isArray ? 'array' : typeof value;
}

function formatAddressForError(value: unknown): string {
  const { address } = normalizeSquadsAddressValue(value);
  return address ?? '[invalid address]';
}

function getObjectRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const { isArray, readFailed: arrayInspectionFailed } =
    inspectArrayValue(value);
  assert(
    !arrayInspectionFailed && value && typeof value === 'object' && !isArray,
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
  const { propertyValue: lengthValue, readError: lengthReadError } =
    inspectPropertyValue(values, 'length');
  if (lengthReadError) {
    throw new Error(
      `Failed to read ${label} length: ${formatUnknownErrorForMessage(lengthReadError)}`,
    );
  }

  if (
    typeof lengthValue !== 'number' ||
    !numberIsSafeInteger(lengthValue) ||
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
  const { propertyValue, readError } = inspectPropertyValue(values, index);
  if (readError) {
    throw new Error(
      `Failed to read ${label}[${index}]: ${formatUnknownErrorForMessage(readError)}`,
    );
  }
  return propertyValue;
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
    const { isArray, readFailed: arrayInspectionFailed } =
      inspectArrayValue(value);
    if (
      arrayInspectionFailed ||
      !value ||
      typeof value !== 'object' ||
      isArray
    ) {
      return {
        address: undefined,
        error: `expected string or object with toBase58(), got ${getUnknownValueTypeName(value)}`,
      };
    }

    const { propertyValue: toBase58Candidate, readError: toBase58ReadError } =
      inspectPropertyValue(value, 'toBase58');
    if (toBase58ReadError) {
      return {
        address: undefined,
        error: `failed to read toBase58() method (${formatUnknownErrorForMessage(toBase58ReadError)})`,
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
          : stringFromValue(toBase58Value);
    } catch (error) {
      return {
        address: undefined,
        error: `failed to stringify key (${formatUnknownErrorForMessage(error)})`,
      };
    }
  }

  const trimmedAddressValue = stringTrim(rawAddressValue);
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
  const { isArray: valuesIsArray, readFailed: valuesReadFailed } =
    inspectArrayValue(values);
  assert(
    !valuesReadFailed && valuesIsArray,
    `Expected address list to be an array, got ${getUnknownValueTypeName(values)}`,
  );

  const normalizedValues = values as readonly unknown[];
  const addresses: string[] = [];
  let invalidEntries = 0;
  const entryCount = getArrayLengthOrThrow(normalizedValues, 'address list');

  for (let index = 0; index < entryCount; index += 1) {
    const { propertyValue: value, readError: valueReadError } =
      inspectPropertyValue(normalizedValues, index);
    if (valueReadError) {
      invalidEntries += 1;
      continue;
    }
    const normalizedAddress = normalizeSquadsAddressValue(value);
    if (normalizedAddress.address) {
      arrayPushValue(addresses, normalizedAddress.address);
    } else {
      invalidEntries += 1;
    }
  }

  return { addresses, invalidEntries };
}

export function parseSquadsMultisigMembers(
  members: unknown,
): ParseSquadsMultisigMembersResult {
  const { isArray: membersAreArray, readFailed: membersReadFailed } =
    inspectArrayValue(members);
  assert(
    !membersReadFailed && membersAreArray,
    `Expected multisig members to be an array, got ${getUnknownValueTypeName(members)}`,
  );

  const normalizedMembers = members as readonly unknown[];
  const parsedMembers: ParsedSquadsMultisigMember[] = [];
  let invalidEntries = 0;
  const memberCount = getArrayLengthOrThrow(
    normalizedMembers,
    'multisig members',
  );

  for (let index = 0; index < memberCount; index += 1) {
    const { propertyValue: member, readError: memberReadError } =
      inspectPropertyValue(normalizedMembers, index);
    if (memberReadError) {
      invalidEntries += 1;
      continue;
    }

    if (!member || typeof member !== 'object') {
      invalidEntries += 1;
      continue;
    }

    const { propertyValue: memberKeyValue, readError: memberKeyReadError } =
      inspectPropertyValue(member, 'key');
    if (memberKeyReadError) {
      invalidEntries += 1;
      continue;
    }
    const normalizedMemberKey = normalizeSquadsAddressValue(memberKeyValue);
    if (!normalizedMemberKey.address) {
      invalidEntries += 1;
      continue;
    }

    const { propertyValue: permissionsValue, readError: permissionsReadError } =
      inspectPropertyValue(member, 'permissions');
    arrayPushValue(parsedMembers, {
      key: normalizedMemberKey.address,
      permissions:
        permissionsReadError || typeof permissionsValue === 'undefined'
          ? null
          : permissionsValue,
    });
  }

  return {
    members: parsedMembers,
    invalidEntries,
  };
}

function isLikelyLogArrayFieldName(fieldName: string): boolean {
  const cached = mapGetValue(SQUADS_LOG_FIELD_NAME_CACHE, fieldName);
  if (typeof cached === 'boolean') {
    return cached;
  }

  const tokens = tokenizeFieldName(fieldName);
  const result =
    arrayIncludesValue(tokens, 'log') || arrayIncludesValue(tokens, 'logs');
  mapSetValue(SQUADS_LOG_FIELD_NAME_CACHE, fieldName, result);
  return result;
}

function parseSquadsProposalVoteErrorText(
  logsText: string,
): SquadsProposalVoteError | undefined {
  const normalizedLogs = stringToLowerCase(logsText);

  for (const { error, patterns } of SQUADS_PROPOSAL_VOTE_ERROR_PATTERNS) {
    if (
      arraySomeValue(patterns, (pattern) =>
        stringIncludesValue(normalizedLogs, pattern),
      )
    ) {
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

  const { isArray: valueIsArray, readFailed: arrayInspectionFailed } =
    inspectArrayValue(value);
  if (arrayInspectionFailed || !valueIsArray) {
    return undefined;
  }

  const normalizedValue = value as readonly unknown[];
  let logEntryCount: number;
  try {
    logEntryCount = getArrayLengthOrThrow(normalizedValue, 'vote log entries');
  } catch {
    return undefined;
  }

  const logEntries: string[] = [];
  for (let index = 0; index < logEntryCount; index += 1) {
    const { propertyValue: entry, readError: entryReadError } =
      inspectPropertyValue(normalizedValue, index);
    if (entryReadError) {
      continue;
    }
    if (typeof entry === 'string') {
      arrayPushValue(logEntries, entry);
    }
  }

  if (logEntries.length === 0) {
    return undefined;
  }

  return parseSquadsProposalVoteErrorText(arrayJoinValues(logEntries, '\n'));
}

function getRecordFieldValue(
  record: Record<string, unknown>,
  fieldName: string,
): unknown {
  const { propertyValue, readError } = inspectPropertyValue(record, fieldName);
  return readError ? undefined : propertyValue;
}

function getRecordKeys(record: Record<string, unknown>): string[] {
  const { keys, readError } = inspectObjectKeys(record);
  return readError ? [] : keys;
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

    if (setHasValue(visitedObjects, current)) {
      continue;
    }
    setAddValue(visitedObjects, current);

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
        !setHasValue(SQUADS_ERROR_KNOWN_ARRAY_FIELD_NAMES, key) &&
        isLikelyLogArrayFieldName(key)
      ) {
        const parsedError =
          parseSquadsProposalVoteErrorFromUnknownLogs(nestedValue);
        if (parsedError) return parsedError;
      }

      if (nestedValue && typeof nestedValue === 'object') {
        arrayPushValue(traversalQueue, nestedValue);
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
    numberIsSafeInteger(parsedValue),
    `Squads ${fieldLabel} must be a JavaScript safe integer: ${displayValue}`,
  );
  const requireNonNegative = readSafeIntegerOptionFlag(
    options,
    fieldLabel,
    'nonNegative',
  );
  if (requireNonNegative) {
    assert(
      parsedValue >= 0,
      `Squads ${fieldLabel} must be a non-negative JavaScript safe integer: ${displayValue}`,
    );
  }
  const requirePositive = readSafeIntegerOptionFlag(
    options,
    fieldLabel,
    'positive',
  );
  if (requirePositive) {
    assert(
      parsedValue > 0,
      `Squads ${fieldLabel} must be a positive JavaScript safe integer: ${displayValue}`,
    );
  }
  return parsedValue;
}

function readSafeIntegerOptionFlag(
  options: unknown,
  fieldLabel: string,
  optionName: 'nonNegative' | 'positive',
): boolean {
  const { propertyValue, readError } = inspectPropertyValue(
    options,
    optionName,
  );
  assert(
    !readError,
    `Failed to read Squads ${fieldLabel} ${optionName} option: ${stringifyUnknownSquadsError(
      readError,
    )}`,
  );
  return booleanFromValue(propertyValue);
}

function normalizeSafeIntegerValue(value: unknown): {
  parsedValue: number;
  displayValue: string;
} {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return {
      parsedValue: numberFromValue(value),
      displayValue: stringFromValue(value),
    };
  }

  if (!value || typeof value !== 'object') {
    return {
      parsedValue: numberNaNValue(),
      displayValue: stringFromValue(value),
    };
  }

  let displayValue: string;
  try {
    displayValue = stringFromValue(value);
  } catch {
    const { propertyValue: toStringCandidate, readError: toStringReadError } =
      inspectPropertyValue(value, 'toString');
    if (toStringReadError) {
      return {
        parsedValue: numberNaNValue(),
        displayValue: '[unstringifiable value]',
      };
    }

    if (typeof toStringCandidate !== 'function') {
      let objectTagValue: string;
      try {
        objectTagValue = objectPrototypeToString(value);
      } catch {
        objectTagValue = '[unstringifiable value]';
      }
      return {
        parsedValue: numberNaNValue(),
        displayValue: objectTagValue,
      };
    }
    return {
      parsedValue: numberNaNValue(),
      displayValue: '[unstringifiable value]',
    };
  }

  if (!SAFE_INTEGER_DECIMAL_PATTERN.test(displayValue)) {
    return {
      parsedValue: numberNaNValue(),
      displayValue,
    };
  }

  return { parsedValue: numberFromValue(displayValue), displayValue };
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
  const {
    propertyValue: getSolanaWeb3ProviderValue,
    readError: getSolanaWeb3ProviderReadError,
  } = inspectPropertyValue(mpp, 'getSolanaWeb3Provider');
  if (getSolanaWeb3ProviderReadError) {
    throw new Error(
      `Failed to read getSolanaWeb3Provider for ${chain}: ${formatUnknownErrorForMessage(getSolanaWeb3ProviderReadError)}`,
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
  const { isArray: providerIsArray, readFailed: providerReadFailed } =
    inspectArrayValue(providerValue);
  assert(
    typeof providerValue === 'object' &&
      providerValue !== null &&
      !providerReadFailed &&
      !providerIsArray,
    `Invalid solana provider for ${chain}: expected object, got ${getUnknownValueTypeName(providerValue)}`,
  );

  const { thenValue, readError: thenReadError } =
    inspectPromiseLikeThenValue(providerValue);
  if (thenReadError) {
    throw new Error(
      `Failed to inspect solana provider for ${chain}: failed to read promise-like then field (${formatUnknownErrorForMessage(thenReadError)})`,
    );
  }

  assert(
    typeof thenValue !== 'function',
    `Invalid solana provider for ${chain}: expected synchronous provider, got promise-like value`,
  );

  const {
    propertyValue: getAccountInfoValue,
    readError: getAccountInfoReadError,
  } = inspectPropertyValue(providerValue, 'getAccountInfo');
  if (getAccountInfoReadError) {
    throw new Error(
      `Failed to read getAccountInfo for ${chain}: ${formatUnknownErrorForMessage(getAccountInfoReadError)}`,
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
  const {
    propertyValue: getChainMetadataValue,
    readError: getChainMetadataReadError,
  } = inspectPropertyValue(mpp, 'getChainMetadata');
  if (getChainMetadataReadError) {
    throw new Error(
      `Failed to read getChainMetadata accessor for ${chain}: ${formatUnknownErrorForMessage(getChainMetadataReadError)}`,
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

  const { isArray: chainMetadataIsArray, readFailed: chainMetadataReadFailed } =
    inspectArrayValue(chainMetadata);
  assert(
    typeof chainMetadata === 'object' &&
      chainMetadata !== null &&
      !chainMetadataReadFailed &&
      !chainMetadataIsArray,
    `Malformed chain metadata for ${chain}: expected object, got ${getUnknownValueTypeName(chainMetadata)}`,
  );

  const {
    thenValue: chainMetadataThenValue,
    readError: chainMetadataThenError,
  } = inspectPromiseLikeThenValue(chainMetadata);
  if (chainMetadataThenError) {
    throw new Error(
      `Failed to inspect chain metadata for ${chain}: failed to read promise-like then field (${formatUnknownErrorForMessage(chainMetadataThenError)})`,
    );
  }

  assert(
    typeof chainMetadataThenValue !== 'function',
    `Malformed chain metadata for ${chain}: expected synchronous object, got promise-like value`,
  );

  const { propertyValue: nativeToken, readError: nativeTokenReadError } =
    inspectPropertyValue(chainMetadata, 'nativeToken');
  if (nativeTokenReadError) {
    throw new Error(
      `Failed to read native token metadata for ${chain}: ${formatUnknownErrorForMessage(nativeTokenReadError)}`,
    );
  }

  const { isArray: nativeTokenIsArray, readFailed: nativeTokenReadFailed } =
    inspectArrayValue(nativeToken);
  assert(
    typeof nativeToken === 'object' &&
      nativeToken !== null &&
      !nativeTokenReadFailed &&
      !nativeTokenIsArray,
    `Malformed native token metadata for ${chain}: expected object, got ${getUnknownValueTypeName(nativeToken)}`,
  );

  const { thenValue: nativeTokenThenValue, readError: nativeTokenThenError } =
    inspectPromiseLikeThenValue(nativeToken);
  if (nativeTokenThenError) {
    throw new Error(
      `Failed to inspect native token metadata for ${chain}: failed to read promise-like then field (${formatUnknownErrorForMessage(nativeTokenThenError)})`,
    );
  }

  assert(
    typeof nativeTokenThenValue !== 'function',
    `Malformed native token metadata for ${chain}: expected synchronous object, got promise-like value`,
  );

  const { propertyValue: decimals, readError: decimalsReadError } =
    inspectPropertyValue(nativeToken, 'decimals');
  if (decimalsReadError) {
    throw new Error(
      `Failed to read native token decimals for ${chain}: ${formatUnknownErrorForMessage(decimalsReadError)}`,
    );
  }

  assert(
    typeof decimals === 'number' &&
      numberIsSafeInteger(decimals) &&
      decimals >= 0,
    `Malformed native token decimals for ${chain}: expected non-negative safe integer, got ${formatSafeIntegerInputValue(decimals)}`,
  );

  const { propertyValue: symbolValue, readError: symbolReadError } =
    inspectPropertyValue(nativeToken, 'symbol');
  if (symbolReadError) {
    throw new Error(
      `Failed to read native token symbol for ${chain}: ${formatUnknownErrorForMessage(symbolReadError)}`,
    );
  }

  assert(
    typeof symbolValue === 'string',
    `Malformed native token symbol for ${chain}: expected non-empty string, got ${getUnknownValueTypeName(symbolValue)}`,
  );

  const symbol = stringTrim(symbolValue);
  assert(
    symbol.length > 0,
    `Malformed native token symbol for ${chain}: expected non-empty string, got empty`,
  );
  assert(
    !isGenericObjectStringifiedValue(symbol),
    `Malformed native token symbol for ${chain}: expected meaningful string, got generic object label`,
  );

  return { decimals, symbol };
}

async function getVaultBalanceForPendingProposals(
  chain: SquadsChainName,
  svmProvider: SolanaWeb3Provider,
  vault: PublicKey,
): Promise<number> {
  const { propertyValue: getBalanceValue, readError: getBalanceReadError } =
    inspectPropertyValue(svmProvider, 'getBalance');
  if (getBalanceReadError) {
    throw new Error(
      `Failed to read getBalance for ${chain}: ${formatUnknownErrorForMessage(getBalanceReadError)}`,
    );
  }

  assert(
    typeof getBalanceValue === 'function',
    `Invalid solana provider for ${chain}: expected getBalance function, got ${getUnknownValueTypeName(getBalanceValue)}`,
  );

  let vaultBalance: unknown;
  try {
    vaultBalance = await getBalanceValue.call(svmProvider, vault);
  } catch (error) {
    throw new Error(
      `Failed to fetch vault balance for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  assert(
    typeof vaultBalance === 'number' &&
      numberIsFinite(vaultBalance) &&
      vaultBalance >= 0,
    `Malformed vault balance for ${chain}: expected non-negative finite number, got ${formatSafeIntegerInputValue(vaultBalance)}`,
  );

  return vaultBalance;
}

function getSignerPublicKeyForChain(
  signerAdapter: unknown,
  chain: SquadsChainName,
): PublicKey {
  const { propertyValue: publicKeyValue, readError: publicKeyReadError } =
    inspectPropertyValue(signerAdapter, 'publicKey');
  if (publicKeyReadError) {
    throw new Error(
      `Failed to read signer publicKey for ${chain}: ${formatUnknownErrorForMessage(publicKeyReadError)}`,
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

  const {
    isArray: signerPublicKeyIsArray,
    readFailed: signerPublicKeyReadFailed,
  } = inspectArrayValue(signerPublicKey);
  assert(
    typeof signerPublicKey === 'object' &&
      signerPublicKey !== null &&
      !signerPublicKeyReadFailed &&
      !signerPublicKeyIsArray,
    `Invalid signer public key for ${chain}: expected PublicKey, got ${getUnknownValueTypeName(signerPublicKey)}`,
  );

  const {
    thenValue: signerPublicKeyThenValue,
    readError: signerPublicKeyThenError,
  } = inspectPromiseLikeThenValue(signerPublicKey);
  if (signerPublicKeyThenError) {
    throw new Error(
      `Failed to inspect signer public key for ${chain}: failed to read promise-like then field (${formatUnknownErrorForMessage(signerPublicKeyThenError)})`,
    );
  }

  assert(
    typeof signerPublicKeyThenValue !== 'function',
    `Invalid signer public key for ${chain}: expected synchronous PublicKey, got promise-like value`,
  );

  const {
    matches: signerPublicKeyIsPublicKey,
    readFailed: signerPublicKeyReadFailedDuringInstanceCheck,
  } = inspectInstanceOf(signerPublicKey, PublicKey);
  assert(
    !signerPublicKeyReadFailedDuringInstanceCheck && signerPublicKeyIsPublicKey,
    `Invalid signer public key for ${chain}: expected PublicKey, got ${getUnknownValueTypeName(signerPublicKey)}`,
  );

  return signerPublicKey as PublicKey;
}

function getSignerBuildAndSendTransactionForChain(
  signerAdapter: unknown,
  chain: SquadsChainName,
): SvmMultiProtocolSignerAdapter['buildAndSendTransaction'] {
  const {
    propertyValue: buildAndSendTransactionValue,
    readError: buildAndSendTransactionReadError,
  } = inspectPropertyValue(signerAdapter, 'buildAndSendTransaction');
  if (buildAndSendTransactionReadError) {
    throw new Error(
      `Failed to read signer buildAndSendTransaction for ${chain}: ${formatUnknownErrorForMessage(buildAndSendTransactionReadError)}`,
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
    const multisig = await getMultisigAccountForNextIndex(
      normalizedChain,
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

function deriveProposalPdaForResolvedChain(
  chain: SquadsChainName,
  transactionIndex: number,
  multisigPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  let proposalPdaTuple: unknown;
  try {
    proposalPdaTuple = getProposalPda({
      multisigPda,
      transactionIndex: bigintFromValue(transactionIndex),
      programId,
    });
  } catch (error) {
    throw new Error(
      `Failed to derive proposal PDA for ${chain} at index ${transactionIndex}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  const {
    isArray: proposalPdaTupleIsArray,
    readFailed: proposalPdaTupleReadFailed,
  } = inspectArrayValue(proposalPdaTuple);
  assert(
    !proposalPdaTupleReadFailed && proposalPdaTupleIsArray,
    `Malformed proposal PDA derivation for ${chain} at index ${transactionIndex}: expected non-empty tuple result`,
  );

  const normalizedProposalPdaTuple = proposalPdaTuple as readonly unknown[];
  const proposalPdaTupleLength = getArrayLengthOrThrow(
    normalizedProposalPdaTuple,
    `proposal PDA tuple for ${chain} at index ${transactionIndex}`,
  );
  assert(
    proposalPdaTupleLength > 0,
    `Malformed proposal PDA derivation for ${chain} at index ${transactionIndex}: expected non-empty tuple result`,
  );

  const proposalPda = getArrayElementOrThrow(
    normalizedProposalPdaTuple,
    0,
    `proposal PDA tuple for ${chain} at index ${transactionIndex}`,
  );
  const {
    matches: proposalPdaIsPublicKey,
    readFailed: proposalPdaReadFailedDuringInstanceCheck,
  } = inspectInstanceOf(proposalPda, PublicKey);
  assert(
    !proposalPdaReadFailedDuringInstanceCheck && proposalPdaIsPublicKey,
    `Malformed proposal PDA derivation for ${chain} at index ${transactionIndex}: expected PublicKey at tuple index 0, got ${getUnknownValueTypeName(proposalPda)}`,
  );

  return proposalPda as PublicKey;
}

async function getProposalAccountForResolvedChain(
  chain: SquadsChainName,
  squadsProvider: ReturnType<typeof toSquadsProvider>,
  proposalPda: PublicKey,
): Promise<accounts.Proposal> {
  const {
    propertyValue: fromAccountAddressValue,
    readError: fromAccountAddressReadError,
  } = inspectPropertyValue(accounts.Proposal, 'fromAccountAddress');
  if (fromAccountAddressReadError) {
    throw new Error(
      `Failed to read proposal account loader for ${chain}: ${formatUnknownErrorForMessage(fromAccountAddressReadError)}`,
    );
  }

  assert(
    typeof fromAccountAddressValue === 'function',
    `Invalid proposal account loader for ${chain}: expected fromAccountAddress function, got ${getUnknownValueTypeName(fromAccountAddressValue)}`,
  );

  let proposalPdaForDisplay = '[invalid address]';
  try {
    proposalPdaForDisplay = proposalPda.toBase58();
  } catch {}

  try {
    return await fromAccountAddressValue.call(
      accounts.Proposal,
      squadsProvider,
      proposalPda,
    );
  } catch (error) {
    throw new Error(
      `Failed to fetch proposal ${proposalPdaForDisplay} on ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }
}

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

    const proposalPda = deriveProposalPdaForResolvedChain(
      chain,
      transactionIndex,
      multisigPda,
      programId,
    );
    const proposal = await getProposalAccountForResolvedChain(
      chain,
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
  const normalizedErrorText = stringToLowerCase(
    formatUnknownErrorForMessage(error),
  );
  return arraySomeValue(
    LIKELY_MISSING_SQUADS_ACCOUNT_ERROR_PATTERNS,
    (pattern) => stringIncludesValue(normalizedErrorText, pattern),
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
      `Skipping chains without Squads config: ${arrayJoinValues(
        nonSquadsChains,
        ', ',
      )}`,
    );
  }

  await promiseAllValues(
    arrayMapValues(squadsChains, async (chain) => {
      try {
        const { decimals, symbol: nativeTokenSymbol } =
          getPendingProposalNativeTokenMetadataForChain(mpp, chain);
        const { svmProvider, vault, multisigPda, programId } =
          getSquadAndProviderForResolvedChain(chain, mpp);
        const squadsProvider = toSquadsProvider(svmProvider);

        const multisig = await getMultisigAccountForNextIndex(
          chain,
          squadsProvider,
          multisigPda,
        );
        const { threshold, currentTransactionIndex, staleTransactionIndex } =
          parseSquadMultisig(multisig, `${chain} multisig`);

        const vaultBalance = await getVaultBalanceForPendingProposals(
          chain,
          svmProvider,
          vault,
        );
        const balanceFormatted = (vaultBalance / 10 ** decimals).toFixed(5);

        rootLogger.info(
          `Fetching proposals for squads ${formatAddressForError(multisigPda)} on ${chain}`,
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
              submissionDate = dateToDateString(
                dateFromUnixTimestampSeconds(statusTimestampSeconds),
              );
            }

            const [transactionPda] = getTransactionPda({
              multisigPda,
              index: bigintFromValue(proposalIndex),
              programId,
            });
            const txHash = formatAddressForError(transactionPda);
            if (txHash === '[invalid address]') {
              rootLogger.warn(
                `Skipping proposal ${proposalIndex} on ${chain} due to malformed transaction PDA`,
              );
              continue;
            }

            arrayPushValue(proposals, {
              chain,
              nonce: proposalIndex,
              status,
              shortTxHash: `${stringSliceValue(txHash, 0, 6)}...${stringSliceValue(txHash, -4)}`,
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

  return arraySortValues(
    proposals,
    (a, b) => stringLocaleCompare(a.chain, b.chain) || a.nonce - b.nonce,
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
    ? stringFromValue(value)
    : getUnknownValueTypeName(value);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): number {
  assert(
    typeof value === 'number' && numberIsSafeInteger(value) && value >= 0,
    `Expected ${label} to be a non-negative safe integer, got ${formatSafeIntegerInputValue(value)}`,
  );
  return value;
}

function assertPositiveSafeInteger(value: unknown, label: string): number {
  assert(
    typeof value === 'number' && numberIsSafeInteger(value) && value > 0,
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

  return numberMax(
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
  const { isArray: statusIsArray, readFailed: statusReadFailed } =
    inspectArrayValue(status);
  assert(
    status && typeof status === 'object' && !statusReadFailed && !statusIsArray,
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
  const normalizedStatusKind = stringTrim(statusKind);
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
  const { isArray: fieldValueIsArray, readFailed: fieldValueReadFailed } =
    inspectArrayValue(fieldValue);
  assert(
    !fieldValueReadFailed && fieldValueIsArray,
    `Squads proposal ${fieldName} votes must be an array`,
  );
  const normalizedFieldValue = fieldValue as readonly unknown[];
  return getArrayLengthOrThrow(
    normalizedFieldValue,
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

  const { isArray: membersIsArray, readFailed: membersReadFailed } =
    inspectArrayValue(members);
  assert(
    !membersReadFailed && membersIsArray,
    `Squads ${fieldPrefix} members must be an array when provided`,
  );
  const normalizedMembers = members as readonly unknown[];

  const memberCount = getArrayLengthOrThrow(
    normalizedMembers,
    `Squads ${fieldPrefix} members`,
  );
  for (let index = 0; index < memberCount; index += 1) {
    const member: unknown = getArrayElementOrThrow(
      normalizedMembers,
      index,
      `Squads ${fieldPrefix} members`,
    );
    const { isArray: memberIsArray, readFailed: memberReadFailed } =
      inspectArrayValue(member);
    assert(
      member &&
        typeof member === 'object' &&
        !memberReadFailed &&
        !memberIsArray,
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
        stringTrim(memberKey).length > 0,
        `Squads ${fieldPrefix} members[${index}] key must be a non-empty string`,
      );
    } else {
      const { isArray: memberKeyIsArray, readFailed: memberKeyReadFailed } =
        inspectArrayValue(memberKey);
      assert(
        typeof memberKey === 'object' &&
          !memberKeyReadFailed &&
          !memberKeyIsArray,
        `Squads ${fieldPrefix} members[${index}] key must be an object or non-empty string`,
      );
      let normalizedMemberKey: string | undefined;
      try {
        normalizedMemberKey = stringFromValue(memberKey);
      } catch {
        // handled by assertion below
      }
      assert(
        typeof normalizedMemberKey === 'string',
        `Squads ${fieldPrefix} members[${index}] key must be stringifiable`,
      );
      const trimmedMemberKey = stringTrim(normalizedMemberKey);
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
    numberIsSafeInteger(mask) && mask >= 0,
    `Expected permission mask to be a non-negative safe integer, got ${stringFromValue(mask)}`,
  );

  const permissions: string[] = [];
  if (mask & SquadsPermission.PROPOSER) arrayPushValue(permissions, 'Proposer');
  if (mask & SquadsPermission.VOTER) arrayPushValue(permissions, 'Voter');
  if (mask & SquadsPermission.EXECUTOR) arrayPushValue(permissions, 'Executor');

  return permissions.length > 0 ? arrayJoinValues(permissions, ', ') : 'None';
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
  const multisig = await getMultisigAccountForNextIndex(
    chain,
    squadsProvider,
    multisigPda,
  );

  const parsedMultisig = parseSquadMultisig(multisig, `${chain} multisig`);
  const currentIndex = bigintFromValue(parsedMultisig.currentTransactionIndex);
  const nextIndex = currentIndex + 1n;

  return nextIndex;
}

async function getMultisigAccountForNextIndex(
  chain: SquadsChainName,
  squadsProvider: ReturnType<typeof toSquadsProvider>,
  multisigPda: PublicKey,
): Promise<accounts.Multisig> {
  const {
    propertyValue: fromAccountAddressValue,
    readError: fromAccountAddressReadError,
  } = inspectPropertyValue(accounts.Multisig, 'fromAccountAddress');
  if (fromAccountAddressReadError) {
    throw new Error(
      `Failed to read multisig account loader for ${chain}: ${formatUnknownErrorForMessage(fromAccountAddressReadError)}`,
    );
  }

  assert(
    typeof fromAccountAddressValue === 'function',
    `Invalid multisig account loader for ${chain}: expected fromAccountAddress function, got ${getUnknownValueTypeName(fromAccountAddressValue)}`,
  );

  try {
    return await fromAccountAddressValue.call(
      accounts.Multisig,
      squadsProvider,
      multisigPda,
    );
  } catch (error) {
    throw new Error(
      `Failed to fetch multisig ${formatAddressForError(multisigPda)} on ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }
}

async function getMultisigAccountInfoForNextIndex(
  chain: SquadsChainName,
  svmProvider: SolanaWeb3Provider,
  multisigPda: PublicKey,
): Promise<unknown> {
  const {
    propertyValue: getAccountInfoValue,
    readError: getAccountInfoReadError,
  } = inspectPropertyValue(svmProvider, 'getAccountInfo');
  if (getAccountInfoReadError) {
    throw new Error(
      `Failed to read getAccountInfo for ${chain}: ${formatUnknownErrorForMessage(getAccountInfoReadError)}`,
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
      `Failed to fetch multisig account ${formatAddressForError(multisigPda)} on ${chain}: ${formatUnknownErrorForMessage(error)}`,
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

  const { propertyValue: ownerValue, readError: ownerReadError } =
    inspectPropertyValue(accountInfo, 'owner');
  if (ownerReadError) {
    rootLogger.warn(
      `Failed to read multisig account owner on ${chain}: ${formatUnknownErrorForMessage(ownerReadError)}`,
    );
    return;
  }

  const {
    matches: ownerIsPublicKey,
    readFailed: ownerReadFailedDuringInstanceCheck,
  } = inspectInstanceOf(ownerValue, PublicKey);
  if (ownerReadFailedDuringInstanceCheck || !ownerIsPublicKey) {
    rootLogger.warn(
      `Skipping multisig owner validation on ${chain}: expected owner PublicKey, got ${getUnknownValueTypeName(ownerValue)}`,
    );
    return;
  }
  const ownerPublicKey = ownerValue as PublicKey;

  let ownerMatchesExpectedProgram = false;
  try {
    ownerMatchesExpectedProgram = ownerPublicKey.equals(expectedProgramId);
  } catch (error) {
    rootLogger.warn(
      `Failed to compare multisig account owner on ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
    return;
  }

  if (!ownerMatchesExpectedProgram) {
    let ownerAddress = '[unavailable owner address]';
    try {
      ownerAddress = ownerPublicKey.toBase58();
    } catch (error) {
      rootLogger.warn(
        `Failed to format multisig account owner on ${chain}: ${formatUnknownErrorForMessage(error)}`,
      );
    }

    let expectedProgramAddress = '[unavailable expected program address]';
    try {
      expectedProgramAddress = expectedProgramId.toBase58();
    } catch (error) {
      rootLogger.warn(
        `Failed to format expected program ID on ${chain}: ${formatUnknownErrorForMessage(error)}`,
      );
    }

    rootLogger.warn(
      `WARNING: Multisig account owner (${ownerAddress}) does not match expected program ID (${expectedProgramAddress})`,
    );
  }
}

function assertValidBigintTransactionIndex(
  transactionIndex: unknown,
  chain: unknown,
): bigint {
  const chainLabel =
    typeof chain === 'string' && stringTrim(chain).length > 0
      ? stringTrim(chain)
      : 'unknown chain';
  assert(
    typeof transactionIndex === 'bigint',
    `Expected transaction index to be a bigint for ${chainLabel}, got ${getUnknownValueTypeName(transactionIndex)}`,
  );
  assert(
    transactionIndex >= 0n,
    `Expected transaction index to be a non-negative bigint for ${chainLabel}, got ${stringFromValue(transactionIndex)}`,
  );

  return transactionIndex;
}

function assertPublicKeyValue(value: unknown, label: string): PublicKey {
  const {
    matches: valueIsPublicKey,
    readFailed: valueReadFailedDuringInstanceCheck,
  } = inspectInstanceOf(value, PublicKey);
  assert(
    !valueReadFailedDuringInstanceCheck && valueIsPublicKey,
    `Expected ${label} to be a PublicKey, got ${getUnknownValueTypeName(value)}`,
  );
  return value as PublicKey;
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
  const { isArray: instructionsAreArray, readFailed: instructionsReadFailed } =
    inspectArrayValue(ixs);
  assert(
    !instructionsReadFailed && instructionsAreArray,
    `Expected proposal instructions for ${chain} to be an array, got ${getUnknownValueTypeName(ixs)}`,
  );

  const normalizedInstructionsInput = ixs as readonly unknown[];
  const normalizedInstructions: TransactionInstruction[] = [];
  const instructionCount = getArrayLengthOrThrow(
    normalizedInstructionsInput,
    `proposal instructions for ${chain}`,
  );
  for (
    let instructionIndex = 0;
    instructionIndex < instructionCount;
    instructionIndex += 1
  ) {
    const instruction = getArrayElementOrThrow(
      normalizedInstructionsInput,
      instructionIndex,
      `proposal instructions for ${chain}`,
    );
    const {
      matches: instructionIsTransactionInstruction,
      readFailed: instructionReadFailedDuringInstanceCheck,
    } = inspectInstanceOf(instruction, TransactionInstruction);
    assert(
      !instructionReadFailedDuringInstanceCheck &&
        instructionIsTransactionInstruction,
      `Expected proposal instructions for ${chain}[${instructionIndex}] to be a TransactionInstruction, got ${getUnknownValueTypeName(instruction)}`,
    );
    arrayPushValue(
      normalizedInstructions,
      instruction as TransactionInstruction,
    );
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

  const normalizedMemo = stringTrim(memo);
  return normalizedMemo.length > 0 ? normalizedMemo : undefined;
}

async function getRecentBlockhashForProposalBuild(
  chain: SquadsChainName,
  svmProvider: SolanaWeb3Provider,
): Promise<string> {
  const {
    propertyValue: getLatestBlockhashValue,
    readError: getLatestBlockhashReadError,
  } = inspectPropertyValue(svmProvider, 'getLatestBlockhash');
  if (getLatestBlockhashReadError) {
    throw new Error(
      `Failed to read getLatestBlockhash for ${chain}: ${formatUnknownErrorForMessage(getLatestBlockhashReadError)}`,
    );
  }

  assert(
    typeof getLatestBlockhashValue === 'function',
    `Invalid solana provider for ${chain}: expected getLatestBlockhash function, got ${getUnknownValueTypeName(getLatestBlockhashValue)}`,
  );

  let latestBlockhashResult: unknown;
  try {
    latestBlockhashResult = await getLatestBlockhashValue.call(svmProvider);
  } catch (error) {
    throw new Error(
      `Failed to fetch latest blockhash for ${chain}: ${formatUnknownErrorForMessage(error)}`,
    );
  }

  const {
    isArray: latestBlockhashResultIsArray,
    readFailed: latestBlockhashResultReadFailed,
  } = inspectArrayValue(latestBlockhashResult);
  assert(
    typeof latestBlockhashResult === 'object' &&
      latestBlockhashResult !== null &&
      !latestBlockhashResultReadFailed &&
      !latestBlockhashResultIsArray,
    `Malformed latest blockhash result for ${chain}: expected object, got ${getUnknownValueTypeName(latestBlockhashResult)}`,
  );

  const { propertyValue: blockhashValue, readError: blockhashReadError } =
    inspectPropertyValue(latestBlockhashResult, 'blockhash');
  if (blockhashReadError) {
    throw new Error(
      `Failed to read latest blockhash value for ${chain}: ${formatUnknownErrorForMessage(blockhashReadError)}`,
    );
  }

  assert(
    typeof blockhashValue === 'string' && stringTrim(blockhashValue).length > 0,
    `Malformed latest blockhash value for ${chain}: expected non-empty string, got ${getUnknownValueTypeName(blockhashValue)}`,
  );
  const normalizedBlockhash = stringTrim(blockhashValue);
  assert(
    !isGenericObjectStringifiedValue(normalizedBlockhash),
    `Malformed latest blockhash value for ${chain}: expected meaningful string, got generic object label`,
  );

  return normalizedBlockhash;
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

  const blockhash = await getRecentBlockhashForProposalBuild(
    normalizedChain,
    svmProvider,
  );
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
  const {
    matches: accountDataIsUint8Array,
    readFailed: accountDataReadFailedDuringInstanceCheck,
  } = inspectInstanceOf(accountData, Uint8Array);
  assert(
    !accountDataReadFailedDuringInstanceCheck && accountDataIsUint8Array,
    `Expected account data to be a Uint8Array, got ${getUnknownValueTypeName(accountData)}`,
  );
}

function hasMatchingDiscriminator(
  accountData: Uint8Array,
  expectedDiscriminator: Uint8Array,
): boolean {
  const discriminator = uint8ArraySubarray(
    accountData,
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
  accountInfo: unknown,
): Uint8Array {
  const { propertyValue: dataValue, readError: dataReadError } =
    inspectPropertyValue(accountInfo, 'data');
  if (dataReadError) {
    throw new Error(
      `Failed to read transaction account data on ${chain}: ${formatUnknownErrorForMessage(dataReadError)}`,
    );
  }

  const {
    matches: dataValueIsUint8Array,
    readFailed: dataValueReadFailedDuringInstanceCheck,
  } = inspectInstanceOf(dataValue, Uint8Array);
  assert(
    !dataValueReadFailedDuringInstanceCheck && dataValueIsUint8Array,
    `Malformed transaction account data on ${chain}: expected Uint8Array, got ${getUnknownValueTypeName(dataValue)}`,
  );

  return dataValue as Uint8Array;
}

async function getTransactionAccountInfoForType(
  chain: SquadsChainName,
  svmProvider: SolanaWeb3Provider,
  transactionPda: PublicKey,
): Promise<unknown> {
  const {
    propertyValue: getAccountInfoValue,
    readError: getAccountInfoReadError,
  } = inspectPropertyValue(svmProvider, 'getAccountInfo');
  if (getAccountInfoReadError) {
    throw new Error(
      `Failed to read getAccountInfo for ${chain}: ${formatUnknownErrorForMessage(getAccountInfoReadError)}`,
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
      `Failed to fetch transaction account ${formatAddressForError(transactionPda)} on ${chain}: ${formatUnknownErrorForMessage(error)}`,
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
    index: bigintFromValue(normalizedTransactionIndex),
    programId,
  });

  const accountInfo = await getTransactionAccountInfoForType(
    normalizedChain,
    svmProvider,
    transactionPda,
  );
  if (!accountInfo) {
    throw new Error(
      `Transaction account not found at ${formatAddressForError(transactionPda)}`,
    );
  }

  const accountData = readTransactionAccountDataForType(
    normalizedChain,
    accountInfo,
  );

  if (isVaultTransaction(accountData)) {
    return SquadsAccountType.VAULT;
  } else if (isConfigTransaction(accountData)) {
    return SquadsAccountType.CONFIG;
  } else {
    const discriminator = uint8ArraySubarray(
      accountData,
      0,
      SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
    );
    throw new Error(
      `Unknown transaction type with discriminator: [${arrayJoinValues(
        arrayFromValue(discriminator),
        ', ',
      )}]. Expected VaultTransaction or ConfigTransaction.`,
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
          transactionIndex: bigintFromValue(normalizedTransactionIndex),
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
        transactionIndex: bigintFromValue(normalizedTransactionIndex),
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

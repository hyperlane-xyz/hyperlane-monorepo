import { PublicKey } from '@solana/web3.js';

import { Address } from '@hyperlane-xyz/utils';
import { stringifyUnknownSquadsError } from './error-format.js';
import {
  inspectArrayValue,
  inspectObjectEntries,
  inspectObjectKeys,
  inspectPropertyValue,
} from './inspection.js';

export type SquadConfig = {
  programId: Address;
  multisigPda: Address;
  vault: Address;
};

export type SquadsKeys = Record<keyof SquadConfig, PublicKey>;

const OBJECT_FREEZE = Object.freeze as <Value>(value: Value) => Readonly<Value>;

function objectFreezeValue<Value>(value: Value): Readonly<Value> {
  return OBJECT_FREEZE(value);
}

export const squadsConfigs = objectFreezeValue({
  solanamainnet: objectFreezeValue({
    programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
    multisigPda: 'EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4',
    vault: '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa',
  }),
  soon: objectFreezeValue({
    programId: 'Hz8Zg8JYFshThnKHXSZV9XJFbyYUUKBb5NJUrxDvF8PB',
    multisigPda: '3tQm2hkauvqoRsfJg6NmUA6eMEWqFdvbiJUZUBFHXD6A',
    vault: '7Y6WDpMfNeb1b4YYbyUkF41z1DuPhvDDuWWJCHPRNa9Y',
  }),
  eclipsemainnet: objectFreezeValue({
    programId: 'eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f',
    multisigPda: 'CSnrKeqrrLm6v9NvChYKT58mfRGYnMk8MeLGWhKvBdbk',
    vault: 'D742EWw9wpV47jRAvEenG1oWHfMmpiQNJLjHTBfXhuRm',
  }),
  sonicsvm: objectFreezeValue({
    programId: 'sqdsFBUUwbsuoLUhoWdw343Je6mvn7dGVVRYCa4wtqJ',
    multisigPda: 'BsdNMofu1a4ncHFJSNZWuTcZae9yt4ZGDuaneN5am5m6',
    vault: '8ECSwp5yo2EeZkozSrpPnMj5Rmcwa4VBYCETE9LHmc9y',
  }),
  solaxy: objectFreezeValue({
    programId: '222DRw2LbM7xztYq1efxcbfBePi6xnv27o7QBGm9bpts',
    multisigPda: 'XgeE3uXEy5bKPbgYv3D9pWovhu3PWrxt3RR5bdp9RkW',
    vault: '4chV16Dea6CW6xyQcHj9RPwBZitfxYgpafkSoZgzy4G8',
  }),
} as const satisfies Record<string, SquadConfig>);

const {
  entries: untypedSquadsConfigEntries,
  readError: squadsConfigEntriesReadError,
} = inspectObjectEntries(squadsConfigs);
if (squadsConfigEntriesReadError) {
  throw createError(
    `Failed to read squads config entries: ${formatUnknownListError(squadsConfigEntriesReadError)}`,
  );
}

const SQUADS_CONFIG_ENTRIES = untypedSquadsConfigEntries as Array<
  [SquadsChainName, (typeof squadsConfigs)[SquadsChainName]]
>;
const OBJECT_FROM_ENTRIES = Object.fromEntries as <
  EntryKey extends PropertyKey,
  EntryValue,
>(
  entries: Iterable<readonly [EntryKey, EntryValue]>,
) => Record<EntryKey, EntryValue>;
const ARRAY_MAP = Array.prototype.map;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_PUSH = Array.prototype.push;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const STRING_FUNCTION = String;
const STRING_TRIM = String.prototype.trim;
const ERROR_CONSTRUCTOR = Error as new (message?: string) => Error;
const SET_CONSTRUCTOR = Set as new <Value>(
  values?: Iterable<Value>,
) => Set<Value>;

function readStaticSquadsConfigFieldOrThrow(
  chainName: string,
  configValue: unknown,
  fieldName: keyof SquadConfig,
): string {
  const { propertyValue, readError } = inspectPropertyValue(
    configValue,
    fieldName,
  );
  if (readError) {
    throw createError(
      `Failed to read ${fieldName} for squads chain ${chainName}: ${formatUnknownListError(readError)}`,
    );
  }
  if (typeof propertyValue !== 'string') {
    throw createError(
      `Malformed ${fieldName} for squads chain ${chainName}: expected string, got ${getUnknownValueTypeName(propertyValue)}`,
    );
  }
  return propertyValue;
}

const SQUADS_KEYS_BY_CHAIN = objectFreezeValue(
  objectFromEntries(
    arrayMapValues(SQUADS_CONFIG_ENTRIES, ([chainName, config]) => [
      chainName,
      objectFreezeValue({
        multisigPda: new PublicKey(
          readStaticSquadsConfigFieldOrThrow(chainName, config, 'multisigPda'),
        ),
        programId: new PublicKey(
          readStaticSquadsConfigFieldOrThrow(chainName, config, 'programId'),
        ),
        vault: new PublicKey(
          readStaticSquadsConfigFieldOrThrow(chainName, config, 'vault'),
        ),
      }),
    ]),
  ) as Record<keyof typeof squadsConfigs, Readonly<SquadsKeys>>,
);

export type SquadsChainName = keyof typeof squadsConfigs;

const { keys: untypedSquadsChainKeys, readError: squadsChainKeysReadError } =
  inspectObjectKeys(squadsConfigs);
if (squadsChainKeysReadError) {
  throw createError(
    `Failed to read squads config chain names: ${formatUnknownListError(squadsChainKeysReadError)}`,
  );
}

const SQUADS_CHAINS = objectFreezeValue(
  untypedSquadsChainKeys as SquadsChainName[],
) as readonly SquadsChainName[];
const SQUADS_CHAIN_SET = createSetValue<string>(SQUADS_CHAINS);
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const SQUADS_CHAINS_DISPLAY_LIST = ARRAY_JOIN.call(SQUADS_CHAINS, ', ');

function setHasValue<Value>(set: Set<Value>, value: Value): boolean {
  return SET_HAS.call(set, value);
}

function setAddValue<Value>(set: Set<Value>, value: Value): void {
  SET_ADD.call(set, value);
}

function createSetValue<Value>(values?: Iterable<Value>): Set<Value> {
  return new SET_CONSTRUCTOR(values);
}

function stringTrim(value: string): string {
  return STRING_TRIM.call(value);
}

function arrayMapValues<Value, Result>(
  values: readonly Value[],
  mapFn: (value: Value, index: number, array: readonly Value[]) => Result,
): Result[] {
  return ARRAY_MAP.call(values, mapFn) as Result[];
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

function objectFromEntries<EntryKey extends PropertyKey, EntryValue>(
  entries: Iterable<readonly [EntryKey, EntryValue]>,
): Record<EntryKey, EntryValue> {
  return OBJECT_FROM_ENTRIES(entries);
}

function numberIsSafeInteger(value: unknown): boolean {
  return NUMBER_IS_SAFE_INTEGER(value);
}

function createError(message?: string): Error {
  return new ERROR_CONSTRUCTOR(message);
}

function stringFromValue(value: unknown): string {
  return STRING_FUNCTION(value);
}

export function getSquadsChains(): SquadsChainName[] {
  return [...SQUADS_CHAINS];
}

export function isSquadsChain(
  chainName: unknown,
): chainName is SquadsChainName {
  return (
    typeof chainName === 'string' && setHasValue(SQUADS_CHAIN_SET, chainName)
  );
}

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const { isArray, readFailed } = inspectArrayValue(value);
  if (readFailed) {
    return '[unreadable value type]';
  }

  return isArray ? 'array' : typeof value;
}

function formatLengthValue(value: unknown): string {
  return typeof value === 'number'
    ? stringFromValue(value)
    : getUnknownValueTypeName(value);
}

function formatUnknownListError(error: unknown): string {
  return stringifyUnknownSquadsError(error, {
    preferErrorMessageForErrorInstances: true,
  });
}

function getArrayLengthOrThrow(
  values: readonly unknown[],
  listLabel: string,
): number {
  const { propertyValue: lengthValue, readError: lengthReadError } =
    inspectPropertyValue(values, 'length');
  if (lengthReadError) {
    throw createError(
      `Failed to read ${listLabel} length: ${formatUnknownListError(lengthReadError)}`,
    );
  }

  if (
    typeof lengthValue !== 'number' ||
    !numberIsSafeInteger(lengthValue) ||
    lengthValue < 0
  ) {
    throw createError(
      `Malformed ${listLabel} length: expected non-negative safe integer, got ${formatLengthValue(lengthValue)}`,
    );
  }

  return lengthValue;
}

function normalizeChainListValues(
  chains: readonly unknown[] | unknown,
  listLabel: string,
): string[] {
  const { isArray, readFailed: arrayInspectionFailed } =
    inspectArrayValue(chains);
  if (arrayInspectionFailed || !isArray) {
    throw createError(
      `Expected ${listLabel} to be an array, got ${getUnknownValueTypeName(chains)}`,
    );
  }

  const normalizedChainValues = chains as readonly unknown[];
  const normalizedChains: string[] = [];
  const chainCount = getArrayLengthOrThrow(normalizedChainValues, listLabel);
  for (let index = 0; index < chainCount; index += 1) {
    const { propertyValue: chain, readError: chainReadError } =
      inspectPropertyValue(normalizedChainValues, index);
    if (chainReadError) {
      throw createError(
        `Failed to read ${listLabel}[${index}]: ${formatUnknownListError(chainReadError)}`,
      );
    }
    if (typeof chain !== 'string') {
      throw createError(
        `Expected ${listLabel}[${index}] to be a string, got ${getUnknownValueTypeName(chain)}`,
      );
    }
    arrayPushValue(normalizedChains, chain);
  }

  return normalizedChains;
}

export function partitionSquadsChains(chains: unknown): {
  squadsChains: SquadsChainName[];
  nonSquadsChains: string[];
} {
  const normalizedChains = normalizeChainListValues(
    chains,
    'partitioned squads chains',
  );
  return partitionNormalizedSquadsChains(normalizedChains);
}

function partitionNormalizedSquadsChains(chains: readonly string[]): {
  squadsChains: SquadsChainName[];
  nonSquadsChains: string[];
} {
  const squadsChains: SquadsChainName[] = [];
  const nonSquadsChains: string[] = [];
  const seenChains = createSetValue<string>();

  for (const chain of chains) {
    const normalizedChain = stringTrim(chain);
    if (setHasValue(seenChains, normalizedChain)) {
      continue;
    }
    setAddValue(seenChains, normalizedChain);

    if (isSquadsChain(normalizedChain)) {
      arrayPushValue(squadsChains, normalizedChain);
    } else {
      arrayPushValue(nonSquadsChains, normalizedChain);
    }
  }

  return { squadsChains, nonSquadsChains };
}

function formatChainNameForDisplay(chain: string): string {
  const trimmedChain = stringTrim(chain);
  return trimmedChain.length > 0 ? trimmedChain : '<empty>';
}

function formatUniqueChainNamesForDisplay(chains: readonly string[]): string[] {
  const seenChainNames = createSetValue<string>();
  const formattedUniqueChainNames: string[] = [];

  for (const chain of chains) {
    const formattedChain = formatChainNameForDisplay(chain);
    if (setHasValue(seenChainNames, formattedChain)) {
      continue;
    }

    setAddValue(seenChainNames, formattedChain);
    arrayPushValue(formattedUniqueChainNames, formattedChain);
  }

  return formattedUniqueChainNames;
}

export function getUnsupportedSquadsChainsErrorMessage(
  nonSquadsChains: unknown,
  configuredSquadsChains: unknown = SQUADS_CHAINS,
): string {
  const normalizedNonSquadsChains = normalizeChainListValues(
    nonSquadsChains,
    'unsupported squads chains',
  );
  if (normalizedNonSquadsChains.length === 0) {
    throw createError(
      'Expected at least one unsupported squads chain to format error message',
    );
  }

  const normalizedConfiguredSquadsChains = normalizeChainListValues(
    configuredSquadsChains,
    'configured squads chains',
  );

  if (normalizedConfiguredSquadsChains.length === 0) {
    throw createError('Expected at least one configured squads chain');
  }

  const formattedUnsupportedChains = formatUniqueChainNamesForDisplay(
    normalizedNonSquadsChains,
  );
  const formattedConfiguredChains = formatUniqueChainNamesForDisplay(
    normalizedConfiguredSquadsChains,
  );

  return (
    `Squads configuration not found for chains: ${arrayJoinValues(formattedUnsupportedChains, ', ')}. ` +
    `Available Squads chains: ${arrayJoinValues(formattedConfiguredChains, ', ')}`
  );
}

export function resolveSquadsChains(chains?: unknown): SquadsChainName[] {
  if (typeof chains === 'undefined') {
    return getSquadsChains();
  }

  const normalizedChains = normalizeChainListValues(chains, 'squads chains');
  if (normalizedChains.length === 0) {
    return getSquadsChains();
  }
  const { squadsChains, nonSquadsChains } =
    partitionNormalizedSquadsChains(normalizedChains);
  if (nonSquadsChains.length > 0) {
    throw createError(getUnsupportedSquadsChainsErrorMessage(nonSquadsChains));
  }

  return [...squadsChains];
}

export function assertIsSquadsChain(
  chainName: unknown,
): asserts chainName is SquadsChainName {
  if (typeof chainName !== 'string') {
    throw createError(
      `Expected chain name to be a string, got ${getUnknownValueTypeName(chainName)}`,
    );
  }

  if (isSquadsChain(chainName)) return;

  throw createError(
    `Squads config not found on chain ${chainName}. Available Squads chains: ${SQUADS_CHAINS_DISPLAY_LIST}`,
  );
}

function normalizeChainNameForSquadsLookup(chainName: unknown): string {
  if (typeof chainName !== 'string') {
    throw createError(
      `Expected chain name to be a string, got ${getUnknownValueTypeName(chainName)}`,
    );
  }

  const normalizedChainName = stringTrim(chainName);
  if (normalizedChainName.length === 0) {
    throw createError('Expected chain name to be a non-empty string');
  }

  return normalizedChainName;
}

export function resolveSquadsChainName(chainName: unknown): SquadsChainName {
  const normalizedChainName = normalizeChainNameForSquadsLookup(chainName);
  assertIsSquadsChain(normalizedChainName);
  return normalizedChainName;
}

export function getSquadsKeysForResolvedChain(chainName: unknown): SquadsKeys {
  assertIsSquadsChain(chainName);
  const keys = SQUADS_KEYS_BY_CHAIN[chainName];

  return objectFreezeValue({
    multisigPda: keys.multisigPda,
    programId: keys.programId,
    vault: keys.vault,
  });
}

export function getSquadsKeys(chainName: unknown): SquadsKeys {
  return getSquadsKeysForResolvedChain(resolveSquadsChainName(chainName));
}

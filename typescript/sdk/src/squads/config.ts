import { PublicKey } from '@solana/web3.js';

import { Address } from '@hyperlane-xyz/utils';
import { stringifyUnknownSquadsError } from './error-format.js';

export type SquadConfig = {
  programId: Address;
  multisigPda: Address;
  vault: Address;
};

export type SquadsKeys = Record<keyof SquadConfig, PublicKey>;

export const squadsConfigs = Object.freeze({
  solanamainnet: Object.freeze({
    programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
    multisigPda: 'EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4',
    vault: '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa',
  }),
  soon: Object.freeze({
    programId: 'Hz8Zg8JYFshThnKHXSZV9XJFbyYUUKBb5NJUrxDvF8PB',
    multisigPda: '3tQm2hkauvqoRsfJg6NmUA6eMEWqFdvbiJUZUBFHXD6A',
    vault: '7Y6WDpMfNeb1b4YYbyUkF41z1DuPhvDDuWWJCHPRNa9Y',
  }),
  eclipsemainnet: Object.freeze({
    programId: 'eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f',
    multisigPda: 'CSnrKeqrrLm6v9NvChYKT58mfRGYnMk8MeLGWhKvBdbk',
    vault: 'D742EWw9wpV47jRAvEenG1oWHfMmpiQNJLjHTBfXhuRm',
  }),
  sonicsvm: Object.freeze({
    programId: 'sqdsFBUUwbsuoLUhoWdw343Je6mvn7dGVVRYCa4wtqJ',
    multisigPda: 'BsdNMofu1a4ncHFJSNZWuTcZae9yt4ZGDuaneN5am5m6',
    vault: '8ECSwp5yo2EeZkozSrpPnMj5Rmcwa4VBYCETE9LHmc9y',
  }),
  solaxy: Object.freeze({
    programId: '222DRw2LbM7xztYq1efxcbfBePi6xnv27o7QBGm9bpts',
    multisigPda: 'XgeE3uXEy5bKPbgYv3D9pWovhu3PWrxt3RR5bdp9RkW',
    vault: '4chV16Dea6CW6xyQcHj9RPwBZitfxYgpafkSoZgzy4G8',
  }),
} as const satisfies Record<string, SquadConfig>);

const SQUADS_KEYS_BY_CHAIN = Object.freeze(
  Object.fromEntries(
    Object.entries(squadsConfigs).map(([chainName, config]) => [
      chainName,
      Object.freeze({
        multisigPda: new PublicKey(config.multisigPda),
        programId: new PublicKey(config.programId),
        vault: new PublicKey(config.vault),
      }),
    ]),
  ) as Record<keyof typeof squadsConfigs, Readonly<SquadsKeys>>,
);

export type SquadsChainName = keyof typeof squadsConfigs;

const SQUADS_CHAINS = Object.freeze(
  Object.keys(squadsConfigs),
) as readonly SquadsChainName[];
const SQUADS_CHAINS_DISPLAY_LIST = SQUADS_CHAINS.join(', ');

export function getSquadsChains(): SquadsChainName[] {
  return [...SQUADS_CHAINS];
}

export function isSquadsChain(
  chainName: unknown,
): chainName is SquadsChainName {
  return (
    typeof chainName === 'string' &&
    Object.prototype.hasOwnProperty.call(squadsConfigs, chainName)
  );
}

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

function formatLengthValue(value: unknown): string {
  return typeof value === 'number'
    ? String(value)
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
  let lengthValue: unknown;
  try {
    lengthValue = values.length;
  } catch (error) {
    throw new Error(
      `Failed to read ${listLabel} length: ${formatUnknownListError(error)}`,
    );
  }

  if (
    typeof lengthValue !== 'number' ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0
  ) {
    throw new Error(
      `Malformed ${listLabel} length: expected non-negative safe integer, got ${formatLengthValue(lengthValue)}`,
    );
  }

  return lengthValue;
}

function normalizeChainListValues(
  chains: readonly unknown[] | unknown,
  listLabel: string,
): string[] {
  if (!Array.isArray(chains)) {
    throw new Error(
      `Expected ${listLabel} to be an array, got ${getUnknownValueTypeName(chains)}`,
    );
  }

  const normalizedChains: string[] = [];
  const chainCount = getArrayLengthOrThrow(chains, listLabel);
  for (let index = 0; index < chainCount; index += 1) {
    let chain: unknown;
    try {
      chain = chains[index];
    } catch (error) {
      throw new Error(
        `Failed to read ${listLabel}[${index}]: ${formatUnknownListError(error)}`,
      );
    }
    if (typeof chain !== 'string') {
      throw new Error(
        `Expected ${listLabel}[${index}] to be a string, got ${getUnknownValueTypeName(chain)}`,
      );
    }
    normalizedChains.push(chain);
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
  const seenChains = new Set<string>();

  for (const chain of chains) {
    const normalizedChain = chain.trim();
    if (seenChains.has(normalizedChain)) {
      continue;
    }
    seenChains.add(normalizedChain);

    if (isSquadsChain(normalizedChain)) {
      squadsChains.push(normalizedChain);
    } else {
      nonSquadsChains.push(normalizedChain);
    }
  }

  return { squadsChains, nonSquadsChains };
}

function formatChainNameForDisplay(chain: string): string {
  const trimmedChain = chain.trim();
  return trimmedChain.length > 0 ? trimmedChain : '<empty>';
}

function formatUniqueChainNamesForDisplay(chains: readonly string[]): string[] {
  const seenChainNames = new Set<string>();
  const formattedUniqueChainNames: string[] = [];

  for (const chain of chains) {
    const formattedChain = formatChainNameForDisplay(chain);
    if (seenChainNames.has(formattedChain)) {
      continue;
    }

    seenChainNames.add(formattedChain);
    formattedUniqueChainNames.push(formattedChain);
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
    throw new Error(
      'Expected at least one unsupported squads chain to format error message',
    );
  }

  const normalizedConfiguredSquadsChains = normalizeChainListValues(
    configuredSquadsChains,
    'configured squads chains',
  );

  if (normalizedConfiguredSquadsChains.length === 0) {
    throw new Error('Expected at least one configured squads chain');
  }

  const formattedUnsupportedChains = formatUniqueChainNamesForDisplay(
    normalizedNonSquadsChains,
  );
  const formattedConfiguredChains = formatUniqueChainNamesForDisplay(
    normalizedConfiguredSquadsChains,
  );

  return (
    `Squads configuration not found for chains: ${formattedUnsupportedChains.join(', ')}. ` +
    `Available Squads chains: ${formattedConfiguredChains.join(', ')}`
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
    throw new Error(getUnsupportedSquadsChainsErrorMessage(nonSquadsChains));
  }

  return [...squadsChains];
}

export function assertIsSquadsChain(
  chainName: unknown,
): asserts chainName is SquadsChainName {
  if (typeof chainName !== 'string') {
    throw new Error(
      `Expected chain name to be a string, got ${getUnknownValueTypeName(chainName)}`,
    );
  }

  if (isSquadsChain(chainName)) return;

  throw new Error(
    `Squads config not found on chain ${chainName}. Available Squads chains: ${SQUADS_CHAINS_DISPLAY_LIST}`,
  );
}

function normalizeChainNameForSquadsLookup(chainName: unknown): string {
  if (typeof chainName !== 'string') {
    throw new Error(
      `Expected chain name to be a string, got ${getUnknownValueTypeName(chainName)}`,
    );
  }

  const normalizedChainName = chainName.trim();
  if (normalizedChainName.length === 0) {
    throw new Error('Expected chain name to be a non-empty string');
  }

  return normalizedChainName;
}

export function resolveSquadsChainName(chainName: unknown): SquadsChainName {
  const normalizedChainName = normalizeChainNameForSquadsLookup(chainName);
  assertIsSquadsChain(normalizedChainName);
  return normalizedChainName;
}

export function getSquadsKeysForResolvedChain(
  chainName: SquadsChainName,
): SquadsKeys {
  assertIsSquadsChain(chainName);
  const keys = SQUADS_KEYS_BY_CHAIN[chainName];

  return Object.freeze({
    multisigPda: keys.multisigPda,
    programId: keys.programId,
    vault: keys.vault,
  });
}

export function getSquadsKeys(chainName: unknown): SquadsKeys {
  return getSquadsKeysForResolvedChain(resolveSquadsChainName(chainName));
}

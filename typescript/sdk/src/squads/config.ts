import { PublicKey } from '@solana/web3.js';

import { Address } from '@hyperlane-xyz/utils';

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

export function getSquadsChains(): SquadsChainName[] {
  return [...SQUADS_CHAINS];
}

export function isSquadsChain(chainName: string): chainName is SquadsChainName {
  return Object.prototype.hasOwnProperty.call(squadsConfigs, chainName);
}

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

function normalizeChainListValues(
  chains: readonly string[],
  listLabel: string,
): string[] {
  const normalizedChains: string[] = [];

  for (const [index, chain] of chains.entries()) {
    if (typeof chain !== 'string') {
      throw new Error(
        `Expected ${listLabel}[${index}] to be a string, got ${getUnknownValueTypeName(chain)}`,
      );
    }
    normalizedChains.push(chain);
  }

  return normalizedChains;
}

export function partitionSquadsChains(chains: readonly string[]): {
  squadsChains: SquadsChainName[];
  nonSquadsChains: string[];
} {
  const squadsChains: SquadsChainName[] = [];
  const nonSquadsChains: string[] = [];
  const seenChains = new Set<string>();

  for (const chain of chains) {
    if (seenChains.has(chain)) {
      continue;
    }
    seenChains.add(chain);

    if (isSquadsChain(chain)) {
      squadsChains.push(chain);
    } else {
      nonSquadsChains.push(chain);
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
  nonSquadsChains: readonly string[],
  configuredSquadsChains: readonly string[] = getSquadsChains(),
): string {
  if (nonSquadsChains.length === 0) {
    throw new Error(
      'Expected at least one unsupported squads chain to format error message',
    );
  }

  const normalizedNonSquadsChains = normalizeChainListValues(
    nonSquadsChains,
    'unsupported squads chains',
  );
  const normalizedConfiguredSquadsChains = normalizeChainListValues(
    configuredSquadsChains,
    'configured squads chains',
  );

  if (normalizedConfiguredSquadsChains.length === 0) {
    throw new Error('Expected at least one configured squads chain');
  }

  const formattedUnsupportedChains =
    formatUniqueChainNamesForDisplay(normalizedNonSquadsChains);
  const formattedConfiguredChains =
    formatUniqueChainNamesForDisplay(normalizedConfiguredSquadsChains);

  return (
    `Squads configuration not found for chains: ${formattedUnsupportedChains.join(', ')}. ` +
    `Available Squads chains: ${formattedConfiguredChains.join(', ')}`
  );
}

export function resolveSquadsChains(
  chains?: readonly string[],
): SquadsChainName[] {
  if (!chains || chains.length === 0) {
    return getSquadsChains();
  }

  const normalizedChains = normalizeChainListValues(chains, 'squads chains').map(
    (chain) => chain.trim(),
  );
  const { squadsChains, nonSquadsChains } =
    partitionSquadsChains(normalizedChains);
  if (nonSquadsChains.length > 0) {
    throw new Error(getUnsupportedSquadsChainsErrorMessage(nonSquadsChains));
  }

  return [...squadsChains];
}

export function assertIsSquadsChain(
  chainName: string,
): asserts chainName is SquadsChainName {
  if (isSquadsChain(chainName)) return;

  throw new Error(
    `Squads config not found on chain ${chainName}. Available Squads chains: ${getSquadsChains().join(', ')}`,
  );
}

export function getSquadsKeys(chainName: string): SquadsKeys {
  assertIsSquadsChain(chainName);
  const keys = SQUADS_KEYS_BY_CHAIN[chainName];

  return {
    multisigPda: keys.multisigPda,
    programId: keys.programId,
    vault: keys.vault,
  };
}

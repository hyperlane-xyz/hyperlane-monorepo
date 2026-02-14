import { PublicKey } from '@solana/web3.js';

import { Address } from '@hyperlane-xyz/utils';

export type SquadConfig = {
  programId: Address;
  multisigPda: Address;
  vault: Address;
};

export type SquadsKeys = Record<keyof SquadConfig, PublicKey>;

export const squadsConfigs = {
  solanamainnet: {
    programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
    multisigPda: 'EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4',
    vault: '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa',
  },
  soon: {
    programId: 'Hz8Zg8JYFshThnKHXSZV9XJFbyYUUKBb5NJUrxDvF8PB',
    multisigPda: '3tQm2hkauvqoRsfJg6NmUA6eMEWqFdvbiJUZUBFHXD6A',
    vault: '7Y6WDpMfNeb1b4YYbyUkF41z1DuPhvDDuWWJCHPRNa9Y',
  },
  eclipsemainnet: {
    programId: 'eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f',
    multisigPda: 'CSnrKeqrrLm6v9NvChYKT58mfRGYnMk8MeLGWhKvBdbk',
    vault: 'D742EWw9wpV47jRAvEenG1oWHfMmpiQNJLjHTBfXhuRm',
  },
  sonicsvm: {
    programId: 'sqdsFBUUwbsuoLUhoWdw343Je6mvn7dGVVRYCa4wtqJ',
    multisigPda: 'BsdNMofu1a4ncHFJSNZWuTcZae9yt4ZGDuaneN5am5m6',
    vault: '8ECSwp5yo2EeZkozSrpPnMj5Rmcwa4VBYCETE9LHmc9y',
  },
  solaxy: {
    programId: '222DRw2LbM7xztYq1efxcbfBePi6xnv27o7QBGm9bpts',
    multisigPda: 'XgeE3uXEy5bKPbgYv3D9pWovhu3PWrxt3RR5bdp9RkW',
    vault: '4chV16Dea6CW6xyQcHj9RPwBZitfxYgpafkSoZgzy4G8',
  },
} as const satisfies Record<string, SquadConfig>;

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

export function getUnsupportedSquadsChainsErrorMessage(
  nonSquadsChains: readonly string[],
  configuredSquadsChains: readonly string[] = getSquadsChains(),
): string {
  if (nonSquadsChains.length === 0) {
    throw new Error(
      'Expected at least one unsupported squads chain to format error message',
    );
  }

  const uniqueConfiguredSquadsChains = Array.from(
    new Set(configuredSquadsChains),
  );
  if (uniqueConfiguredSquadsChains.length === 0) {
    throw new Error('Expected at least one configured squads chain');
  }

  const formattedUnsupportedChains = Array.from(
    new Set(nonSquadsChains.map(formatChainNameForDisplay)),
  );
  const formattedConfiguredChains = Array.from(
    new Set(uniqueConfiguredSquadsChains.map(formatChainNameForDisplay)),
  );

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

  const { squadsChains, nonSquadsChains } = partitionSquadsChains(chains);
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
  const config = squadsConfigs[chainName];

  return {
    multisigPda: new PublicKey(config.multisigPda),
    programId: new PublicKey(config.programId),
    vault: new PublicKey(config.vault),
  };
}

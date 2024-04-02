import { ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  IsmConfig,
  MultiProvider,
  MultisigConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { parseIsmConfig } from '../config/ism.js';
import { log, logGreen } from '../logger.js';
import { assertGasBalances } from '../utils/balances.js';
import { assertSigner } from '../utils/keys.js';

export async function runPreflightChecks({
  origin,
  remotes,
  signer,
  multiProvider,
  minGas,
  chainsToGasCheck,
}: {
  origin: ChainName;
  remotes: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  minGas: string;
  chainsToGasCheck?: ChainName[];
}) {
  log('Running pre-flight checks...');

  if (!origin || !remotes?.length) throw new Error('Invalid chain selection');
  logGreen('Chain selections are valid ✅');

  if (remotes.includes(origin))
    throw new Error('Origin and remotes must be distinct');
  logGreen('Origin and remote are distinct ✅');

  return runPreflightChecksForChains({
    chains: [origin, ...remotes],
    signer,
    multiProvider,
    minGas,
    chainsToGasCheck,
  });
}

export async function runPreflightChecksForChains({
  chains,
  signer,
  multiProvider,
  minGas,
  chainsToGasCheck,
}: {
  chains: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  minGas: string;
  // Chains for which to assert a native balance
  // Defaults to all chains if not specified
  chainsToGasCheck?: ChainName[];
}) {
  log('Running pre-flight checks for chains...');

  if (!chains?.length) throw new Error('Empty chain selection');
  for (const chain of chains) {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    if (!metadata) throw new Error(`No chain config found for ${chain}`);
    if (metadata.protocol !== ProtocolType.Ethereum)
      throw new Error('Only Ethereum chains are supported for now');
  }
  logGreen('Chains are valid ✅');

  assertSigner(signer);
  logGreen('Signer is valid ✅');

  await assertGasBalances(
    multiProvider,
    signer,
    chainsToGasCheck ?? chains,
    minGas,
  );
  logGreen('Balances are sufficient ✅');
}

// from parsed types
export function isISMConfig(
  config: ChainMap<MultisigConfig> | ChainMap<IsmConfig>,
): boolean {
  return Object.values(config).some((c) => 'type' in c);
}

// directly from filepath
export function isZODISMConfig(filepath: string): boolean {
  return parseIsmConfig(filepath).success;
}

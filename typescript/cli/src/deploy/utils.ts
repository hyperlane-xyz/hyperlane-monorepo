import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { log, logGreen } from '../../logger.js';
import { assertNativeBalances } from '../utils/balances.js';
import { assertSigner } from '../utils/keys.js';

export async function runPreflightChecks({
  origin,
  remotes,
  signer,
  multiProvider,
  minBalanceWei,
}: {
  origin: ChainName;
  remotes: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  minBalanceWei: string;
}) {
  log('Running pre-flight checks...');

  if (!origin || !remotes?.length) throw new Error('Invalid chain selection');
  if (remotes.includes(origin))
    throw new Error('Origin and remotes must be distinct');
  return runPreflightChecksForChains({
    chains: [origin, ...remotes],
    signer,
    multiProvider,
    minBalanceWei,
  });
}

export async function runPreflightChecksForChains({
  chains,
  signer,
  multiProvider,
  minBalanceWei,
}: {
  chains: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  minBalanceWei: string;
}) {
  log('Running pre-flight checks...');

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

  await assertNativeBalances(multiProvider, signer, chains, minBalanceWei);
  logGreen('Balances are sufficient ✅');
}

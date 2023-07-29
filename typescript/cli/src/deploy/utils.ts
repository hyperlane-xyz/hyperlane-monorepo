import { ethers } from 'ethers';

import { ChainName, MultiProvider, ProtocolType } from '@hyperlane-xyz/sdk';

import { log, logGreen } from '../logger.js';
import { assertBalances } from '../utils/balances.js';
import { assertSigner } from '../utils/keys.js';

export async function runPreflightChecks({
  local,
  remotes,
  signer,
  multiProvider,
  minBalance,
}: {
  local: ChainName;
  remotes: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  minBalance: number;
}) {
  log('Running pre-flight checks...');

  if (!local || !remotes?.length) throw new Error('Invalid chain selection');
  if (remotes.includes(local))
    throw new Error('Local and remotes must be distinct');
  for (const chain of [local, ...remotes]) {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    if (!metadata) throw new Error(`No chain config found for ${chain}`);
    if (metadata.protocol !== ProtocolType.Ethereum)
      throw new Error('Only Ethereum chains are supported for now');
  }
  logGreen('Chains are valid ✅');

  assertSigner(signer);
  logGreen('Signer is valid ✅');

  await assertBalances(multiProvider, signer, [local, ...remotes], minBalance);
  logGreen('Balances are sufficient ✅');
}

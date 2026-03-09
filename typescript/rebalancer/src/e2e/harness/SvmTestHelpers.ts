import { Connection, PublicKey } from '@solana/web3.js';
import { providers } from 'ethers';

import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { SealevelLocalChainManager } from './SealevelLocalChainManager.js';

/**
 * Get the balance of an SVM warp route token account in lamports.
 */
export async function getSvmWarpRouteBalance(
  connection: Connection,
  warpTokenAta: string,
): Promise<bigint> {
  const balance = await connection.getBalance(new PublicKey(warpTokenAta));
  return BigInt(balance);
}

/**
 * Get the current confirmed slot on an SVM chain.
 */
export async function getSvmSlot(connection: Connection): Promise<number> {
  return connection.getSlot('confirmed');
}

/**
 * Compute block tags for both EVM and SVM chains.
 * Returns a map of chain names to their confirmed block numbers/slots.
 */
export async function computeMixedBlockTags(
  evmProviders: Map<string, providers.JsonRpcProvider>,
  svmConnection: Connection,
  svmChainName: string,
): Promise<ConfirmedBlockTags> {
  const tags: ConfirmedBlockTags = {};

  // Get EVM block numbers
  for (const [chain, provider] of evmProviders) {
    const hex = await provider.send('eth_blockNumber', []);
    tags[chain] = parseInt(hex, 16);
  }

  // Get SVM slot
  const slot = await svmConnection.getSlot('confirmed');
  tags[svmChainName] = slot;

  return tags;
}

/**
 * Fund an SVM warp route token account with lamports.
 */
export async function fundSvmWarpRoute(
  chainManager: SealevelLocalChainManager,
  warpTokenAta: string,
  amountLamports: number,
): Promise<void> {
  await chainManager.fundWarpRoute(warpTokenAta, amountLamports);
}

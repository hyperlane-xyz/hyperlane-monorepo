import type { Logger } from 'pino';

import {
  EthJsonRpcBlockParameterTag,
  MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';

import type { ConfirmedBlockTag } from '../interfaces/IMonitor.js';

/**
 * Get the confirmed block tag for a chain, accounting for reorg period.
 * Returns a block number that is safe from reorgs, or a named tag like 'finalized'.
 *
 * @param multiProvider - MultiProtocolProvider instance
 * @param chainName - Name of the chain
 * @param logger - Optional logger for warnings
 * @returns Confirmed block tag (number, named tag, or undefined on error)
 */
export async function getConfirmedBlockTag(
  multiProvider: MultiProtocolProvider,
  chainName: string,
  logger?: Logger,
): Promise<ConfirmedBlockTag> {
  try {
    const metadata = multiProvider.getChainMetadata(chainName);
    const rpcUrl = metadata.rpcUrls?.[0]?.http ?? '';
    const isLocalRpc =
      chainName.startsWith('anvil') ||
      rpcUrl.includes('localhost') ||
      rpcUrl.includes('127.0.0.1');
    const provider = multiProvider.getViemProvider(chainName);
    const latestBlock = await provider.getBlockNumber();

    // Local test chains should not lag behind by reorgPeriod when asserting
    // per-cycle state transitions in e2e tests.
    if (isLocalRpc) {
      return Number(latestBlock);
    }

    const reorgPeriod = metadata.blocks?.reorgPeriod ?? 32;

    if (typeof reorgPeriod === 'string') {
      return reorgPeriod as EthJsonRpcBlockParameterTag;
    }

    return Math.max(0, Number(latestBlock) - reorgPeriod);
  } catch (error) {
    logger?.warn(
      { chain: chainName, error: (error as Error).message },
      'Failed to get confirmed block, using latest',
    );
    return undefined;
  }
}

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
    const reorgPeriod = metadata.blocks?.reorgPeriod ?? 32;

    if (typeof reorgPeriod === 'string') {
      return reorgPeriod as EthJsonRpcBlockParameterTag;
    }

    const provider = multiProvider.getEthersV5Provider(chainName);
    const latestBlock = await provider.getBlockNumber();
    return Math.max(0, latestBlock - reorgPeriod);
  } catch (error) {
    logger?.warn(
      { chain: chainName, error: (error as Error).message },
      'Failed to get confirmed block, using latest',
    );
    return undefined;
  }
}

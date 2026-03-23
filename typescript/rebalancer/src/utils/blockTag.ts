import type { Logger } from 'pino';

import { providers } from 'ethers';

import {
  EthJsonRpcBlockParameterTag,
  MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';
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

    // Only EVM chains support block tag queries
    if (metadata.protocol !== ProtocolType.Ethereum) {
      return undefined;
    }

    const reorgPeriod = metadata.blocks?.reorgPeriod ?? 32;
    if (typeof reorgPeriod === 'string') {
      return reorgPeriod as EthJsonRpcBlockParameterTag;
    }

    const provider = multiProvider.getEthersV5Provider(chainName);
    let latestBlock: number;
    if (provider instanceof providers.JsonRpcProvider) {
      const latestBlockHex = await provider.send('eth_blockNumber', []);
      if (
        typeof latestBlockHex !== 'string' ||
        !/^0x[0-9a-fA-F]+$/.test(latestBlockHex)
      ) {
        throw new Error(
          `Invalid eth_blockNumber response for ${chainName}: ${latestBlockHex}`,
        );
      }
      latestBlock = parseInt(latestBlockHex, 16);
      if (!Number.isFinite(latestBlock)) {
        throw new Error(
          `Parsed block number is not finite for ${chainName}: ${latestBlockHex}`,
        );
      }
    } else {
      latestBlock = await provider.getBlockNumber();
    }
    return Math.max(0, latestBlock - reorgPeriod);
  } catch (error) {
    logger?.warn(
      { chain: chainName, error: (error as Error).message },
      'Failed to get confirmed block, using latest',
    );
    return undefined;
  }
}

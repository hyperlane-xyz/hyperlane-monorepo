import type { Logger } from 'pino';

import { providers } from 'ethers';

import {
  EthJsonRpcBlockParameterTag,
  type MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { isEVMLike, ProtocolType } from '@hyperlane-xyz/utils';
import type { ConfirmedBlockTag } from '../interfaces/IMonitor.js';

/**
 * Get the confirmed block tag for a chain, accounting for reorg period.
 * Returns a block number that is safe from reorgs, or a named tag like 'finalized'.
 *
 * @param multiProvider - Provider registry with chain metadata and ethers access
 * @param chainName - Name of the chain
 * @param logger - Optional logger for warnings
 * @returns Confirmed block tag, or undefined for optional tags, metadata errors or failed Ethereum lookups.
 * @throws If a numeric Tron block lookup fails.
 */
export async function getConfirmedBlockTag(
  multiProvider: Pick<
    MultiProtocolProvider,
    'getChainMetadata' | 'getEthersV5Provider'
  >,
  chainName: string,
  logger?: Logger,
): Promise<ConfirmedBlockTag> {
  let numericTronLookup = false;
  try {
    const metadata = multiProvider.getChainMetadata(chainName);

    // Only EVM-like chains support block tag queries (e.g., Ethereum, Tron).
    // Tron uses TronJsonRpcProvider which supports eth_blockNumber
    if (!isEVMLike(metadata.protocol)) {
      return undefined;
    }

    const reorgPeriod = metadata.blocks?.reorgPeriod ?? 32;
    if (typeof reorgPeriod === 'string') {
      if (metadata.protocol === ProtocolType.Tron) {
        logger?.warn(
          { chain: chainName, reorgPeriod },
          'Tron does not support named block tags — ignoring string reorgPeriod, using latest block',
        );
        return undefined;
      }
      return reorgPeriod as EthJsonRpcBlockParameterTag;
    }

    numericTronLookup = metadata.protocol === ProtocolType.Tron;
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
    } else {
      latestBlock = await provider.getBlockNumber();
    }
    if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) {
      throw new Error(`Invalid block number for ${chainName}: ${latestBlock}`);
    }
    return Math.max(0, latestBlock - reorgPeriod);
  } catch (error) {
    logger?.warn(
      {
        chain: chainName,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to get confirmed block',
    );
    // For Tron, undefined is intentional only in named-tag mode. A failed
    // numeric lookup must not silently query supply at latest instead.
    if (numericTronLookup) throw error;
    return undefined;
  }
}

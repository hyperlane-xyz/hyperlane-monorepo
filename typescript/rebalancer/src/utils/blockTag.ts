import type { Logger } from 'pino';

import { providers } from 'ethers';

import {
  EthJsonRpcBlockParameterTag,
  type MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { assert, isEVMLike, ProtocolType } from '@hyperlane-xyz/utils';
import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk/runtime';
import type { ConfirmedBlockTag } from '../interfaces/IMonitor.js';

const HEX_BLOCK_NUMBER_REGEX = /^0x[0-9a-fA-F]+$/;

/**
 * Get the confirmed-state query mode for a chain. EVM named finality resolves
 * once to an exact height; Tron uses its native moving solidified state.
 *
 * @param multiProvider - Provider registry with chain metadata and ethers access
 * @param chainName - Name of the chain
 * @param logger - Optional logger for warnings
 * @returns An exact EVM height, the explicit Tron finalized tag, or undefined
 * for another protocol without historical queries.
 */
export async function getConfirmedBlockTag(
  multiProvider: Pick<
    MultiProtocolProvider,
    'getChainMetadata' | 'getEthersV5Provider'
  >,
  chainName: string,
  logger?: Logger,
): Promise<ConfirmedBlockTag> {
  try {
    const metadata = multiProvider.getChainMetadata(chainName);

    // Undefined identifies protocols without EVM snapshot support. Tron has an
    // explicit finalized-state mode; neither mode falls back to latest EVM state.
    if (!isEVMLike(metadata.protocol)) return undefined;

    const reorgPeriod = metadata.blocks?.reorgPeriod ?? 32;
    const provider = multiProvider.getEthersV5Provider(chainName);
    if (metadata.protocol === ProtocolType.Tron) {
      assert(
        provider instanceof TronJsonRpcProvider,
        `Missing Tron provider for ${chainName}`,
      );
      // Tron cannot query historical contract state. The native Solidity API
      // provides irreversible state; settlement changes require a fresh balance cycle.
      return EthJsonRpcBlockParameterTag.Finalized;
    }
    if (typeof reorgPeriod === 'string') {
      const block = await provider.getBlock(reorgPeriod);
      assert(
        block && Number.isSafeInteger(block.number) && block.number >= 0,
        `Invalid ${reorgPeriod} block for ${chainName}`,
      );
      return block.number;
    }

    let latestBlock: number;
    if (
      provider instanceof providers.JsonRpcProvider ||
      provider instanceof TronJsonRpcProvider
    ) {
      const latestBlockHex = await provider.send('eth_blockNumber', []);
      if (
        typeof latestBlockHex !== 'string' ||
        !HEX_BLOCK_NUMBER_REGEX.test(latestBlockHex)
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
    const confirmedBlock = Math.max(0, latestBlock - reorgPeriod);
    return confirmedBlock;
  } catch (error) {
    logger?.warn(
      { chain: chainName, error },
      'Failed to resolve confirmed balance snapshot',
    );
    throw error;
  }
}

import { Address, assert } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainNameOrId } from '../../types.js';

import { GetEventLogsResponse } from './types.js';

// calling getCode until the creation block is found
export async function getContractCreationBlockFromRpc(
  chain: ChainNameOrId,
  contractAddress: Address,
  multiProvider: MultiProvider,
): Promise<number> {
  const provider = multiProvider.getProvider(chain);

  const [latestBlock, latestCode] = await Promise.all([
    provider.getBlockNumber(),
    provider.getCode(contractAddress),
  ]);
  assert(
    latestCode !== '0x',
    `Address "${contractAddress}" on chain "${chain}" is not a contract`,
  );

  let low = 0;
  let high = latestBlock;
  let creationBlock = latestBlock;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(contractAddress, mid);

    if (code !== '0x') {
      creationBlock = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return creationBlock;
}

export type GetLogsFromRpcOptions = {
  chain: ChainNameOrId;
  contractAddress: Address;
  multiProvider: MultiProvider;
  fromBlock: number;
  topic: string;
  toBlock?: number;
  range?: number;
};

export async function getLogsFromRpc({
  chain,
  contractAddress,
  multiProvider,
  fromBlock,
  topic,
  toBlock,
  range = 500,
}: GetLogsFromRpcOptions): Promise<GetEventLogsResponse[]> {
  const provider = multiProvider.getProvider(chain);

  let currentStartBlock = fromBlock;
  const endBlock = toBlock ?? (await provider.getBlockNumber());

  const logs = [];
  while (currentStartBlock <= endBlock) {
    const currentEndBlock =
      currentStartBlock + range < endBlock
        ? currentStartBlock + range
        : endBlock;

    const currentLogs = await provider.getLogs({
      address: contractAddress,
      fromBlock: currentStartBlock,
      toBlock: currentEndBlock,
      topics: [topic],
    });
    logs.push(...currentLogs);

    // +1 because getLogs range is inclusive
    currentStartBlock += range + 1;
  }

  return logs.map((rawLog): GetEventLogsResponse => {
    return {
      address: rawLog.address,
      blockNumber: rawLog.blockNumber,
      data: rawLog.data,
      logIndex: rawLog.logIndex,
      topics: rawLog.topics,
      transactionHash: rawLog.transactionHash,
      transactionIndex: rawLog.transactionIndex,
    };
  });
}

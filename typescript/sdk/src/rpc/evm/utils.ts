import { Hex, Log } from 'viem';

import { Address } from '@hyperlane-xyz/utils';

import {
  assertIsContractAddress,
  isContractAddress,
} from '../../contracts/contracts.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainNameOrId } from '../../types.js';

import { GetEventLogsResponse } from './types.js';

// calling getCode until the creation block is found
export async function getContractCreationBlockFromRpc(
  chain: ChainNameOrId,
  contractAddress: Address,
  multiProvider: MultiProvider,
): Promise<number> {
  await assertIsContractAddress(multiProvider, chain, contractAddress);

  const provider = multiProvider.getProvider(chain);
  const latestBlock = await provider.getBlockNumber();

  let low = 0;
  let high = latestBlock;
  let creationBlock = latestBlock;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const isContract = await isContractAddress(
      multiProvider,
      chain,
      contractAddress,
      mid,
    );

    if (isContract) {
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

export function viemLogFromGetEventLogsResponse(
  log: GetEventLogsResponse,
): Log {
  return {
    address: log.address as Hex,
    data: log.data as Hex,
    blockNumber: BigInt(log.blockNumber),
    transactionHash: log.transactionHash as Hex,
    logIndex: Number(log.logIndex),
    transactionIndex: Number(log.transactionIndex),
    topics: log.topics as [Hex, ...Hex[]],
    blockHash: null,
    removed: false,
  };
}

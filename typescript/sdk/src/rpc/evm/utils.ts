import { Hex, Log } from 'viem';

import { Address } from '@hyperlane-xyz/utils';

import {
  assertIsContractAddress,
  isContractAddress,
} from '../../contracts/contracts.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainNameOrId } from '../../types.js';

import { GetEventLogsResponse } from './types.js';

function toNumber(value: unknown, field: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return Number(BigInt(value));
    return Number(value);
  }
  if (typeof value === 'object' && value && 'toString' in value) {
    const raw = value.toString();
    if (raw.startsWith('0x')) return Number(BigInt(raw));
    return Number(raw);
  }
  throw new Error(`Unable to convert ${field} to number`);
}

function toString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`Unable to convert ${field} to string`);
}

function toStringArray(value: unknown, field: string): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value;
  }
  throw new Error(`Unable to convert ${field} to string[]`);
}

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
      address: toString(rawLog.address, 'address'),
      blockNumber: toNumber(rawLog.blockNumber, 'blockNumber'),
      data: toString(rawLog.data, 'data'),
      logIndex: toNumber(rawLog.logIndex, 'logIndex'),
      topics: toStringArray(rawLog.topics, 'topics'),
      transactionHash: toString(rawLog.transactionHash, 'transactionHash'),
      transactionIndex: toNumber(rawLog.transactionIndex, 'transactionIndex'),
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

import { Hex, Log } from 'viem';

import { Address, assert } from '@hyperlane-xyz/utils';

import {
  assertIsContractAddress,
  isContractAddress,
} from '../../contracts/contracts.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainNameOrId } from '../../types.js';

import { GetEventLogsResponse } from './types.js';

function toNumber(value: unknown, field: string): number {
  if (typeof value === 'number') {
    assert(Number.isSafeInteger(value), `${field} is not a safe integer: ${value}`);
    return value;
  }
  if (typeof value === 'bigint') {
    const num = Number(value);
    assert(
      Number.isFinite(num) && BigInt(num) === value,
      `${field} bigint value ${value} exceeds safe integer range`,
    );
    return num;
  }
  if (typeof value === 'string') {
    assert(
      /^0x[0-9a-fA-F]+$/.test(value) || /^[0-9]+$/.test(value),
      `${field} string "${value}" is not a valid hex or decimal number`,
    );
    const num = value.startsWith('0x')
      ? parseInt(value, 16)
      : parseInt(value, 10);
    assert(!Number.isNaN(num), `${field} parsed to NaN from "${value}"`);
    assert(
      Number.isSafeInteger(num),
      `${field} string value "${value}" exceeds safe integer range`,
    );
    return num;
  }
  assert(false, `Unable to convert ${field} to number`);
}

function toString(value: unknown, field: string): string {
  assert(typeof value === 'string', `Unable to convert ${field} to string`);
  return value;
}

function toStringArray(value: unknown, field: string): string[] {
  assert(
    Array.isArray(value) && value.every((v) => typeof v === 'string'),
    `Unable to convert ${field} to string[]`,
  );
  return value;
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

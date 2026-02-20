import { toHex } from 'viem';

import {
  chunk,
  isBigNumberish,
  isNullish,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  AllProviderMethods,
  IProviderMethods,
  ProviderMethod,
} from './ProviderMethods.js';
import { RpcConfigWithConnectionInfo } from './types.js';

const NUM_LOG_BLOCK_RANGES_TO_QUERY = 10;
const NUM_PARALLEL_LOG_QUERIES = 5;

export class HyperlaneJsonRpcProvider implements IProviderMethods {
  protected readonly logger = rootLogger.child({ module: 'JsonRpcProvider' });
  public readonly supportedMethods = AllProviderMethods;
  private requestId = 0;
  public readonly connection: RpcConfigWithConnectionInfo['connection'];

  constructor(
    public readonly rpcConfig: RpcConfigWithConnectionInfo,
    public readonly network:
      | number
      | string
      | { chainId: number; name: string },
    public readonly options?: { debug?: boolean },
    connectionOverride?: RpcConfigWithConnectionInfo['connection'],
  ) {
    this.connection = connectionOverride ??
      rpcConfig.connection ?? {
        url: rpcConfig.http,
      };
  }

  prepareRequest(method: string, params: any): [string, any[]] {
    if (method === ProviderMethod.MaxPriorityFeePerGas) {
      return ['eth_maxPriorityFeePerGas', []];
    }
    switch (method as ProviderMethod) {
      case ProviderMethod.Call:
        return ['eth_call', [params.transaction, params.blockTag ?? 'latest']];
      case ProviderMethod.EstimateGas:
        return ['eth_estimateGas', [params.transaction]];
      case ProviderMethod.GetBalance:
        return [
          'eth_getBalance',
          [params.address, params.blockTag ?? 'latest'],
        ];
      case ProviderMethod.GetBlock:
        return [
          'eth_getBlockByNumber',
          [toBlockTag(params.blockTag), params.includeTransactions ?? false],
        ];
      case ProviderMethod.GetBlockNumber:
        return ['eth_blockNumber', []];
      case ProviderMethod.GetCode:
        return ['eth_getCode', [params.address, params.blockTag ?? 'latest']];
      case ProviderMethod.GetGasPrice:
        return ['eth_gasPrice', []];
      case ProviderMethod.GetStorageAt:
        return [
          'eth_getStorageAt',
          [params.address, params.position, params.blockTag ?? 'latest'],
        ];
      case ProviderMethod.GetTransaction:
        return ['eth_getTransactionByHash', [params.transactionHash]];
      case ProviderMethod.GetTransactionCount:
        return [
          'eth_getTransactionCount',
          [params.address, params.blockTag ?? 'latest'],
        ];
      case ProviderMethod.GetTransactionReceipt:
        return ['eth_getTransactionReceipt', [params.transactionHash]];
      case ProviderMethod.GetLogs:
        return ['eth_getLogs', [params.filter]];
      case ProviderMethod.SendTransaction:
        return ['eth_sendRawTransaction', [params.signedTransaction]];
      default:
        throw new Error(`Unsupported method ${method}`);
    }
  }

  protected async request(method: string, params: unknown[]): Promise<any> {
    const requestBody = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    };
    const response = await fetch(this.connection?.url || this.rpcConfig.http, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.connection?.headers || {}),
      },
      body: JSON.stringify(requestBody),
    });
    const json = (await response.json()) as {
      result?: unknown;
      error?: { message?: string; code?: number; data?: unknown };
    };
    if (json.error) {
      const error = new Error(
        json.error.message || 'RPC request failed',
      ) as Error & {
        code?: string;
        error?: { code?: number; data?: unknown };
      };
      error.code = 'SERVER_ERROR';
      error.error = {
        code: json.error.code,
        data: json.error.data,
      };
      throw error;
    }
    return json.result;
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    return this.request(method, params);
  }

  async perform(method: string, params: any, reqId?: number): Promise<any> {
    if (this.options?.debug)
      this.logger.debug(
        `HyperlaneJsonRpcProvider performing method ${method} for reqId ${reqId}`,
      );
    if (method === ProviderMethod.GetLogs) {
      return this.performGetLogs(params);
    }

    const [rpcMethod, rpcParams] = this.prepareRequest(method, params);
    const result = await this.request(rpcMethod, rpcParams);
    if (
      result === '0x' &&
      [
        ProviderMethod.Call,
        ProviderMethod.GetBalance,
        ProviderMethod.GetBlock,
        ProviderMethod.GetBlockNumber,
      ].includes(method as ProviderMethod)
    ) {
      this.logger.debug(
        `Received 0x result from ${method} for reqId ${reqId}.`,
      );
      throw new Error('Invalid response from provider');
    }
    return result;
  }

  async performGetLogs(params: {
    filter: {
      fromBlock?: number | string;
      toBlock?: number | string;
      address?: string | string[];
      topics?: Array<string | Array<string> | null>;
    };
  }): Promise<any> {
    const superPerform = async () => {
      const [rpcMethod, rpcParams] = this.prepareRequest(
        ProviderMethod.GetLogs,
        params,
      );
      return this.request(rpcMethod, rpcParams);
    };

    const paginationOptions = this.rpcConfig.pagination;
    if (!paginationOptions || !params.filter) return superPerform();

    const { fromBlock, toBlock, address, topics } = params.filter;
    const { maxBlockRange, minBlockNumber, maxBlockAge } = paginationOptions;

    if (!maxBlockRange && !maxBlockAge && isNullish(minBlockNumber))
      return superPerform();

    const [blockNumberMethod, blockNumberParams] = this.prepareRequest(
      ProviderMethod.GetBlockNumber,
      null,
    );
    const currentBlockNumber = parseBlockNumber(
      await this.request(blockNumberMethod, blockNumberParams),
    );

    let endBlock: number;
    if (isNullish(toBlock) || toBlock === 'latest') {
      endBlock = currentBlockNumber;
    } else if (isBigNumberish(toBlock)) {
      endBlock = Number(BigInt(toBlock.toString()));
    } else {
      return superPerform();
    }

    let startBlock: number;
    if (isNullish(fromBlock) || fromBlock === 'earliest') {
      startBlock = 0;
    } else if (isBigNumberish(fromBlock)) {
      startBlock = Number(BigInt(fromBlock.toString()));
    } else {
      return superPerform();
    }

    if (startBlock > endBlock) {
      this.logger.info(
        `Start block ${startBlock} greater than end block. Using ${endBlock} instead`,
      );
      startBlock = endBlock;
    }
    const minForBlockRange = maxBlockRange
      ? endBlock - maxBlockRange * NUM_LOG_BLOCK_RANGES_TO_QUERY + 1
      : 0;
    if (startBlock < minForBlockRange) {
      this.logger.info(
        `Start block ${startBlock} requires too many queries, using ${minForBlockRange}.`,
      );
      startBlock = minForBlockRange;
    }
    const minForBlockAge = maxBlockAge ? currentBlockNumber - maxBlockAge : 0;
    if (startBlock < minForBlockAge) {
      this.logger.info(
        `Start block ${startBlock} below max block age, increasing to ${minForBlockAge}`,
      );
      startBlock = minForBlockAge;
    }
    if (minBlockNumber && startBlock < minBlockNumber) {
      this.logger.info(
        `Start block ${startBlock} below config min, increasing to ${minBlockNumber}`,
      );
      startBlock = minBlockNumber;
    }

    const blockChunkRange = maxBlockRange || endBlock - startBlock;
    const blockChunks: [number, number][] = [];
    for (let from = startBlock; from <= endBlock; from += blockChunkRange) {
      const to = Math.min(from + blockChunkRange - 1, endBlock);
      blockChunks.push([from, to]);
    }

    let combinedResults: Array<{
      address: string;
      blockHash: string;
      blockNumber: number;
      data: string;
      logIndex: number;
      removed: boolean;
      topics: string[];
      transactionHash: string;
      transactionIndex: number;
    }> = [];
    const requestChunks = chunk(blockChunks, NUM_PARALLEL_LOG_QUERIES);
    for (const reqChunk of requestChunks) {
      const resultPromises = reqChunk.map(async (blockChunk) => {
        const [rpcMethod, rpcParams] = this.prepareRequest(
          ProviderMethod.GetLogs,
          {
            filter: {
              address,
              topics,
              fromBlock: toHex(blockChunk[0]),
              toBlock: toHex(blockChunk[1]),
            },
          },
        );
        return this.request(rpcMethod, rpcParams) as Promise<
          typeof combinedResults
        >;
      });
      const results = await Promise.all(resultPromises);
      combinedResults = [...combinedResults, ...results.flat()];
    }

    return combinedResults;
  }

  getBaseUrl(): string {
    return this.connection?.url || this.rpcConfig.http;
  }
}

function toBlockTag(blockTag?: string | number): string {
  if (blockTag === undefined || blockTag === null) return 'latest';
  if (typeof blockTag === 'number') return toHex(blockTag);
  return blockTag;
}

function parseBlockNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return Number(BigInt(value));
    return Number(value);
  }
  return 0;
}

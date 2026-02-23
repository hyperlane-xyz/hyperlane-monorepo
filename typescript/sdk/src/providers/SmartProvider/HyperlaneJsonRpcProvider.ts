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
        return [
          'eth_call',
          [
            normalizeRpcTransaction(params.transaction),
            params.blockTag ?? 'latest',
          ],
        ];
      case ProviderMethod.EstimateGas:
        return [
          'eth_estimateGas',
          [normalizeRpcTransaction(params.transaction)],
        ];
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
        return ['eth_getLogs', [normalizeLogFilter(params.filter)]];
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

    let response: Response;
    try {
      response = await fetch(this.connection?.url || this.rpcConfig.http, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.connection?.headers,
        },
        body: JSON.stringify(sanitizeJsonRpcValue(requestBody)),
      });
    } catch (cause) {
      throw createServerError(cause);
    }

    let json: { result?: unknown; error?: JsonRpcErrorPayload };
    try {
      json = (await response.json()) as {
        result?: unknown;
        error?: JsonRpcErrorPayload;
      };
    } catch (cause) {
      throw createServerError(cause);
    }

    if (json.error) throw createMappedRpcError(json.error);

    if (!response.ok) throw createServerError();

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

function toBlockTag(blockTag?: string | number | bigint): string {
  if (blockTag === undefined || blockTag === null) return 'latest';
  if (typeof blockTag === 'number' || typeof blockTag === 'bigint') {
    return toHex(blockTag);
  }
  if (/^[0-9]+$/.test(blockTag)) return toHex(BigInt(blockTag));
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

function normalizeRpcTransaction(
  transaction: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!transaction) return {};
  const request = { ...transaction };
  const gas = request.gas ?? request.gasLimit;
  const normalized: Record<string, unknown> = {
    ...request,
    chainId: toRpcQuantity(request.chainId),
    gas: toRpcQuantity(gas),
    gasPrice: toRpcQuantity(request.gasPrice),
    maxFeePerGas: toRpcQuantity(request.maxFeePerGas),
    maxPriorityFeePerGas: toRpcQuantity(request.maxPriorityFeePerGas),
    nonce: toRpcQuantity(request.nonce),
    type: toRpcQuantity(request.type),
    value: toRpcQuantity(request.value),
  };
  delete normalized.gasLimit;

  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined || value === null) delete normalized[key];
  }

  return sanitizeJsonRpcValue(normalized) as Record<string, unknown>;
}

function normalizeLogFilter(
  filter: {
    fromBlock?: string | number | bigint;
    toBlock?: string | number | bigint;
  } & Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...filter };
  if (normalized.fromBlock !== undefined) {
    normalized.fromBlock = toBlockTag(normalized.fromBlock);
  }
  if (normalized.toBlock !== undefined) {
    normalized.toBlock = toBlockTag(normalized.toBlock);
  }
  return normalized;
}

function toRpcQuantity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return value;
    return toHex(BigInt(value));
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return toHex(BigInt(value));
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    return toHex(BigInt(value.toString()));
  }
  return undefined;
}

function sanitizeJsonRpcValue(value: unknown): unknown {
  if (typeof value === 'bigint') return toHex(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'toBigInt' in value &&
    typeof (value as { toBigInt?: unknown }).toBigInt === 'function'
  ) {
    return toHex((value as { toBigInt: () => bigint }).toBigInt());
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizeJsonRpcValue(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeJsonRpcValue(item),
      ]),
    );
  }
  return value;
}

type JsonRpcErrorPayload = {
  code?: number;
  data?: unknown;
  message?: string;
};

type MappedRpcError = Error & {
  code?: string;
  data?: unknown;
  reason?: string;
  error?: {
    code?: number;
    data?: unknown;
    message?: string;
  };
};

function createServerError(cause?: unknown): MappedRpcError {
  const error = new Error('RPC request failed', {
    cause,
  }) as MappedRpcError;
  error.code = 'SERVER_ERROR';
  return error;
}

function createMappedRpcError(rpcError: JsonRpcErrorPayload): MappedRpcError {
  const message = rpcError.message || 'RPC request failed';
  const error = new Error(message) as MappedRpcError;

  if (rpcError.code === 3) {
    // EIP-1474 code 3 is a contract execution revert.
    error.code = 'CALL_EXCEPTION';
    error.reason = message;
    error.data = rpcError.data;
  } else {
    error.code = 'SERVER_ERROR';
  }

  error.error = {
    code: rpcError.code,
    data: rpcError.data,
    message: rpcError.message,
  };
  return error;
}

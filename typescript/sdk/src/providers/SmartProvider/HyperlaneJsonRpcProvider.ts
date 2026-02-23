import { createPublicClient, http, toHex } from 'viem';

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
  public readonly connection: RpcConfigWithConnectionInfo['connection'];
  private readonly client: ReturnType<typeof createPublicClient>;

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

    const url = this.connection?.url || this.rpcConfig.http;
    const chainId =
      typeof this.network === 'object'
        ? this.network.chainId
        : Number(this.network);
    const chainName =
      typeof this.network === 'object'
        ? this.network.name
        : String(this.network);

    this.client = createPublicClient({
      chain: {
        id: Number.isFinite(chainId) ? chainId : 0,
        name: chainName,
        network: chainName,
        nativeCurrency: { name: '', symbol: '', decimals: 18 },
        rpcUrls: {
          default: { http: [url] },
          public: { http: [url] },
        },
      },
      transport: http(url, {
        fetchOptions: this.connection?.headers
          ? { headers: this.connection.headers as Record<string, string> }
          : undefined,
        retryCount: 0,
        timeout: getTimeout(this.connection),
      }),
    });
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
    try {
      return await this.client.request({
        method,
        params: sanitizeJsonRpcValue(params),
      });
    } catch (error) {
      throw mapViemError(error);
    }
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

function getTimeout(connection: RpcConfigWithConnectionInfo['connection']) {
  const timeout = connection?.timeout;
  if (typeof timeout === 'number' && Number.isFinite(timeout)) {
    return timeout;
  }
  return undefined;
}

function mapViemError(error: unknown): MappedRpcError {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return error as MappedRpcError;
  }

  const numericCode = extractNumericCode(error);
  const data = extractData(error);
  const extractedMessage = extractMessage(error) || 'RPC request failed';

  const mapped = new Error(extractedMessage, {
    cause: error instanceof Error ? error : undefined,
  }) as MappedRpcError;

  if (isCallException(numericCode, extractedMessage, data)) {
    mapped.code = 'CALL_EXCEPTION';
    mapped.reason = extractedMessage;
    mapped.data = data;
  } else if (isInsufficientFunds(extractedMessage)) {
    mapped.code = 'INSUFFICIENT_FUNDS';
  } else if (isNonceIssue(extractedMessage)) {
    mapped.code = 'NONCE_EXPIRED';
  } else if (isReplacementUnderpriced(extractedMessage)) {
    mapped.code = 'REPLACEMENT_UNDERPRICED';
  } else {
    mapped.code = 'SERVER_ERROR';
    // Preserve previous SmartProvider behavior for transport failures:
    // expose canonical SERVER_ERROR message instead of generic fetch text.
    mapped.message = 'RPC request failed';
  }

  // Only attach nested JSON-RPC error payload when RPC returned one.
  // For transport failures we intentionally omit nested error.message so
  // SmartProvider emits canonical SERVER_ERROR guidance.
  if (numericCode !== undefined || data !== undefined) {
    mapped.error = {
      code: numericCode,
      data,
      message: extractedMessage,
    };
  }

  return mapped;
}

function extractNumericCode(error: unknown): number | undefined {
  const visited = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current) || typeof current !== 'object')
      continue;
    visited.add(current);

    const record = current as Record<string, unknown>;
    if (typeof record.code === 'number') return record.code;

    for (const key of ['error', 'cause']) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return undefined;
}

function extractData(error: unknown): unknown {
  const visited = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current) || typeof current !== 'object')
      continue;
    visited.add(current);

    const record = current as Record<string, unknown>;
    if (record.data !== undefined) return record.data;

    for (const key of ['error', 'cause']) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return undefined;
}

function extractMessage(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current) || typeof current !== 'object')
      continue;
    visited.add(current);

    const record = current as Record<string, unknown>;
    for (const key of ['shortMessage', 'details', 'message']) {
      if (typeof record[key] === 'string' && record[key]) {
        return record[key] as string;
      }
    }

    for (const key of ['error', 'cause']) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return undefined;
}

function isCallException(
  numericCode: number | undefined,
  message: string,
  data: unknown,
): boolean {
  if (numericCode === 3) return true;
  const lower = message.toLowerCase();
  if (lower.includes('execution reverted')) return true;
  if (lower.includes('returned no data')) return true;
  if (typeof data === 'string' && data !== '0x') return true;
  return false;
}

function isInsufficientFunds(message: string): boolean {
  return message.toLowerCase().includes('insufficient funds');
}

function isNonceIssue(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('nonce too low') ||
    lower.includes('nonce too high') ||
    lower.includes('nonce has already been used')
  );
}

function isReplacementUnderpriced(message: string): boolean {
  return message.toLowerCase().includes('replacement transaction underpriced');
}

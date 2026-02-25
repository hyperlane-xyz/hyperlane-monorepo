import {
  FetchRequest,
  JsonRpcProvider,
  Log,
  Networkish,
  toBeHex,
  toBigInt,
} from 'ethers';

import {
  chunk,
  isNumberish,
  isNullish,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  AllProviderMethods,
  IProviderMethods,
  ProviderMethod,
} from './ProviderMethods.js';
import { RpcConfigWithConnectionInfo, RpcConnectionInfo } from './types.js';

const NUM_LOG_BLOCK_RANGES_TO_QUERY = 10;
const NUM_PARALLEL_LOG_QUERIES = 5;

function getConnectionRequest(
  rpcConfig: RpcConfigWithConnectionInfo,
  connectionOverride?: RpcConnectionInfo,
): string | FetchRequest {
  const connection = connectionOverride ?? rpcConfig.connection;
  if (!connection) return rpcConfig.http;
  const request = new FetchRequest(connection.url);
  for (const [key, value] of Object.entries(connection.headers ?? {})) {
    request.setHeader(key, value);
  }
  return request;
}

export class HyperlaneJsonRpcProvider
  extends JsonRpcProvider
  implements IProviderMethods
{
  protected readonly logger = rootLogger.child({ module: 'JsonRpcProvider' });
  public readonly supportedMethods = AllProviderMethods;

  constructor(
    public readonly rpcConfig: RpcConfigWithConnectionInfo,
    network: Networkish,
    public readonly options?: { debug?: boolean },
    public readonly connectionInfo?: RpcConnectionInfo,
  ) {
    super(getConnectionRequest(rpcConfig, connectionInfo), network);
  }

  async perform(method: string, params: any, reqId?: number): Promise<any> {
    if (this.options?.debug) {
      this.logger.debug(
        `HyperlaneJsonRpcProvider performing method ${method} for reqId ${reqId}`,
      );
    }
    if (method === ProviderMethod.GetLogs) {
      return this.performGetLogs(params);
    }

    const result = await this.performMethod(method as ProviderMethod, params);
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

  private performMethod(method: ProviderMethod, params: any): Promise<any> {
    switch (method) {
      case ProviderMethod.Call: {
        const tx = {
          ...(params?.transaction ?? params?.tx),
          blockTag: params?.blockTag,
        };
        return this.call(tx);
      }
      case ProviderMethod.EstimateGas:
        return this.estimateGas(params?.transaction ?? params?.tx);
      case ProviderMethod.GetBalance:
        return this.getBalance(params?.address, params?.blockTag);
      case ProviderMethod.GetBlock:
        return this.getBlock(params?.blockTag ?? params?.block ?? 'latest');
      case ProviderMethod.GetBlockNumber:
        return this.getBlockNumber();
      case ProviderMethod.GetCode:
        return this.getCode(params?.address, params?.blockTag);
      case ProviderMethod.GetGasPrice:
        return this.send('eth_gasPrice', []).then((value) => toBigInt(value));
      case ProviderMethod.GetStorageAt:
        return this.getStorage(
          params?.address,
          params?.position ?? params?.slot,
          params?.blockTag,
        );
      case ProviderMethod.GetTransaction:
        return this.getTransaction(params?.hash ?? params?.transactionHash);
      case ProviderMethod.GetTransactionCount:
        return this.getTransactionCount(params?.address, params?.blockTag);
      case ProviderMethod.GetTransactionReceipt:
        return this.getTransactionReceipt(
          params?.hash ?? params?.transactionHash,
        );
      case ProviderMethod.SendTransaction:
        return this.send('eth_sendRawTransaction', [
          params?.signedTransaction ?? params?.signedTx ?? params,
        ]);
      case ProviderMethod.MaxPriorityFeePerGas:
        return this.send('eth_maxPriorityFeePerGas', []);
      default:
        throw new Error(`Unsupported method ${method}`);
    }
  }

  async performGetLogs(params: { filter: any }): Promise<any> {
    const superPerform = () => this.getLogs(params.filter);

    const paginationOptions = this.rpcConfig.pagination;
    if (!paginationOptions || !params.filter) return superPerform();

    const { fromBlock, toBlock, address, topics } = params.filter;
    const { maxBlockRange, minBlockNumber, maxBlockAge } = paginationOptions;

    if (!maxBlockRange && !maxBlockAge && isNullish(minBlockNumber))
      return superPerform();

    const currentBlockNumber = await this.getBlockNumber();

    let endBlock: number;
    if (isNullish(toBlock) || toBlock === 'latest') {
      endBlock = currentBlockNumber;
    } else if (isNumberish(toBlock)) {
      endBlock = Number(toBlock);
    } else {
      return superPerform();
    }

    let startBlock: number;
    if (isNullish(fromBlock) || fromBlock === 'earliest') {
      startBlock = 0;
    } else if (isNumberish(fromBlock)) {
      startBlock = Number(fromBlock);
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

    let combinedResults: Array<Log> = [];
    const requestChunks = chunk(blockChunks, NUM_PARALLEL_LOG_QUERIES);
    for (const reqChunk of requestChunks) {
      const resultPromises = reqChunk.map(
        ([from, to]) =>
          this.send('eth_getLogs', [
            {
              address,
              topics,
              fromBlock: toBeHex(from),
              toBlock: toBeHex(to),
            },
          ]) as Promise<Array<Log>>,
      );
      const results = await Promise.all(resultPromises);
      combinedResults = [...combinedResults, ...results.flat()];
    }

    return combinedResults;
  }

  getBaseUrl(): string {
    return this.rpcConfig.http;
  }
}

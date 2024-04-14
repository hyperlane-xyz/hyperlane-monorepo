import { BigNumber, providers, utils } from 'ethers';

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

export class HyperlaneJsonRpcProvider
  extends providers.StaticJsonRpcProvider
  implements IProviderMethods
{
  protected readonly logger = rootLogger.child({ module: 'JsonRpcProvider' });
  public readonly supportedMethods = AllProviderMethods;

  constructor(
    public readonly rpcConfig: RpcConfigWithConnectionInfo,
    network: providers.Networkish,
    public readonly options?: { debug?: boolean },
  ) {
    super(rpcConfig.connection ?? rpcConfig.http, network);
  }

  async perform(method: string, params: any, reqId?: number): Promise<any> {
    if (this.options?.debug)
      this.logger.debug(
        `HyperlaneJsonRpcProvider performing method ${method} for reqId ${reqId}`,
      );
    if (method === ProviderMethod.GetLogs) {
      return this.performGetLogs(params);
    }

    const result = await super.perform(method, params);
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

  async performGetLogs(params: { filter: providers.Filter }): Promise<any> {
    const superPerform = () => super.perform(ProviderMethod.GetLogs, params);

    const paginationOptions = this.rpcConfig.pagination;
    if (!paginationOptions || !params.filter) return superPerform();

    const { fromBlock, toBlock, address, topics } = params.filter;
    const { maxBlockRange, minBlockNumber, maxBlockAge } = paginationOptions;

    if (!maxBlockRange && !maxBlockAge && isNullish(minBlockNumber))
      return superPerform();

    const currentBlockNumber = await super.perform(
      ProviderMethod.GetBlockNumber,
      null,
    );

    let endBlock: number;
    if (isNullish(toBlock) || toBlock === 'latest') {
      endBlock = currentBlockNumber;
    } else if (isBigNumberish(toBlock)) {
      endBlock = BigNumber.from(toBlock).toNumber();
    } else {
      return superPerform();
    }

    let startBlock: number;
    if (isNullish(fromBlock) || fromBlock === 'earliest') {
      startBlock = 0;
    } else if (isBigNumberish(fromBlock)) {
      startBlock = BigNumber.from(fromBlock).toNumber();
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

    let combinedResults: Array<providers.Log> = [];
    const requestChunks = chunk(blockChunks, NUM_PARALLEL_LOG_QUERIES);
    for (const reqChunk of requestChunks) {
      const resultPromises = reqChunk.map(
        (blockChunk) =>
          super.perform(ProviderMethod.GetLogs, {
            filter: {
              address,
              topics,
              fromBlock: utils.hexValue(BigNumber.from(blockChunk[0])),
              toBlock: utils.hexValue(BigNumber.from(blockChunk[1])),
            },
          }) as Promise<Array<providers.Log>>,
      );
      const results = await Promise.all(resultPromises);
      combinedResults = [...combinedResults, ...results.flat()];
    }

    return combinedResults;
  }

  getBaseUrl(): string {
    return this.connection.url;
  }
}

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
import {
  getMultiAddressLogs,
  isMultiAddressFilter,
  normalizeMultiAddress,
} from './logFilters.js';
import { HyperlaneLogFilter, RpcConfigWithConnectionInfo } from './types.js';

/**
 * The most chunks of `pagination.maxBlockRange` a single eth_getLogs request is
 * split into. Anything up to this is served in full; beyond it the request is
 * rejected with {@link LogBlockRangeTooLargeError} rather than answered over a
 * narrower window, so a caller never mistakes a partial log set for a complete
 * one.
 *
 * It bounds the work one request may cause rather than fitting any chain's
 * history: a registry maxBlockRange is what the chain declares, not necessarily
 * what its endpoints enforce, so a bound sized to declared values would be sized
 * to numbers that do not always hold. Where it sits therefore only decides how
 * soon the split is refused, not whether a scan can complete: `getLogsFromRpc`
 * reads the rejection as a block range error and halves its own chunk, so a
 * caller that paginates carries on with smaller requests. Only a caller issuing
 * one unpaginated request over a very deep span sees it as a failure.
 */
const MAX_LOG_BLOCK_RANGES_TO_QUERY = 2_000;
const NUM_PARALLEL_LOG_QUERIES = 5;

/**
 * Thrown when a log query would take more than
 * {@link MAX_LOG_BLOCK_RANGES_TO_QUERY} sub-queries to serve in full.
 *
 * The message names the block range because that is what `isBlockRangeError` in
 * `rpc/evm/utils.ts` matches on, so a paginating caller shrinks its chunks and
 * completes the scan instead of failing it.
 */
export class LogBlockRangeTooLargeError extends Error {
  static {
    this.prototype.name = this.name;
  }
}

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
    connectionOverride?: utils.ConnectionInfo,
  ) {
    super(
      connectionOverride ?? rpcConfig.connection ?? rpcConfig.http,
      network,
    );
  }

  prepareRequest(method: string, params: any): [string, any[]] {
    if (method === ProviderMethod.MaxPriorityFeePerGas) {
      return ['eth_maxPriorityFeePerGas', []];
    }
    if (
      method === ProviderMethod.GetLogs &&
      Array.isArray(params?.filter?.address)
    ) {
      const normalizedAddresses = normalizeMultiAddress(
        params.filter.address,
      ).map((address) => address.toLowerCase());
      return [
        'eth_getLogs',
        [
          {
            ...params.filter,
            address: normalizedAddresses,
          },
        ],
      ];
    }
    return super.prepareRequest(method, params);
  }

  override async getLogs(
    filter: HyperlaneLogFilter | Promise<HyperlaneLogFilter>,
  ): Promise<providers.Log[]> {
    const resolvedFilter = await filter;
    if (!isMultiAddressFilter(resolvedFilter)) {
      return super.getLogs(resolvedFilter);
    }
    return getMultiAddressLogs(this, resolvedFilter);
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

    // Some RPCs return "" instead of null for the `to` field on contract creation txs,
    // which causes ethers.js formatter to throw "invalid address". Normalize to null.
    if (
      result != null &&
      result.to === '' &&
      (method === ProviderMethod.GetTransaction ||
        method === ProviderMethod.GetTransactionReceipt)
    ) {
      result.to = null;
    }

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

  async performGetLogs(params: { filter: HyperlaneLogFilter }): Promise<any> {
    const superPerform = () => super.perform(ProviderMethod.GetLogs, params);

    const paginationOptions = this.rpcConfig.pagination;
    if (!paginationOptions || !params.filter || 'blockHash' in params.filter)
      return superPerform();

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

    if (maxBlockRange) {
      const requiredQueries = Math.ceil(
        (endBlock - startBlock + 1) / maxBlockRange,
      );
      if (requiredQueries > MAX_LOG_BLOCK_RANGES_TO_QUERY) {
        throw new LogBlockRangeTooLargeError(
          `Serving blocks ${startBlock} to ${endBlock} needs ${requiredQueries} queries at a block range of ${maxBlockRange}, above the ${MAX_LOG_BLOCK_RANGES_TO_QUERY} this provider issues for one request`,
        );
      }
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

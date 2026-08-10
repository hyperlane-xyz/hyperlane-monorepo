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

const NUM_PARALLEL_LOG_QUERIES = 5;

/**
 * The most chunks of `pagination.maxBlockRange` a single eth_getLogs request is
 * split into. Anything up to this is served in full; beyond it the request is
 * rejected with {@link LogBlockRangeTooLargeError} rather than answered over a
 * narrower window, so a caller never mistakes a partial log set for a complete
 * one.
 *
 * At {@link NUM_PARALLEL_LOG_QUERIES} in flight this is two batches of serial
 * round trips, which is what keeps the split abandonable. Nothing cancels the
 * sub-queries once they are running: SmartProvider stops waiting on a slow
 * request and reports a timeout while the remaining batches carry on unread, so
 * every batch beyond the point where that timeout fires is work the caller's
 * retry then repeats.
 *
 * Holding it low costs volume nothing. The sub-queries a deep scan needs are
 * its span divided by maxBlockRange whatever this is; the bound only decides
 * how they are grouped into requests. `getLogsFromRpc` reads the rejection as a
 * block range error and halves its own chunk, so a paginating caller pays one
 * rejection per factor of two between its starting chunk and what this admits,
 * once, and then carries on at the reduced chunk. Only a caller issuing a
 * single unpaginated request over a span wider than maxBlockRange times this
 * sees the bound as a failure.
 */
const MAX_LOG_BLOCK_RANGES_TO_QUERY = 10;

/**
 * Thrown when a log query would take more than
 * {@link MAX_LOG_BLOCK_RANGES_TO_QUERY} sub-queries to serve in full.
 *
 * The message names the block range because that is what `isBlockRangeError` in
 * `rpc/evm/utils.ts` matches on, so a paginating caller shrinks its chunks and
 * completes the scan instead of failing it.
 *
 * The decision is made from the requested span alone, before any log query is
 * issued, and is the same every time it is asked, so the error carries
 * `isRecoverable = false` to keep SmartProvider from spending its retry budget
 * and backoffs re-deriving it. That flag is also what `isTerminalLogReadError`
 * reads, which is why `getLogsFromRpc` classifies a range rejection first.
 */
export class LogBlockRangeTooLargeError extends Error {
  readonly isRecoverable = false;

  static {
    this.prototype.name = this.name;
  }
}

/**
 * Thrown when a log query reaches below the earliest block this RPC says it
 * serves, through either `pagination.minBlockNumber` or
 * `pagination.maxBlockAge`.
 *
 * The start block used to be raised to the floor and the logs of the remaining
 * window returned, which is the silent truncation
 * {@link LogBlockRangeTooLargeError} removes on the other bound: nothing in the
 * response marked the blocks that had been dropped.
 *
 * Unlike a span that is too wide, this is not something a caller can page
 * around, because no part of the missing history is on this endpoint at any
 * chunk size. The only recovery is another RPC, so the message deliberately
 * avoids the wording `isBlockRangeError` in `rpc/evm/utils.ts` matches, and the
 * error carries `isRecoverable = false` so that `getLogsFromRpc` surfaces it at
 * once instead of halving its way to the one block minimum first. SmartProvider
 * moves on to the next provider either way, and once every provider has refused
 * it passes the flag on rather than retrying them all again.
 */
export class LogBlockHistoryUnavailableError extends Error {
  readonly isRecoverable = false;

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
    // Whichever of the two floors is higher is the block this provider
    // actually starts at, and is the one the refusal has to name. Reporting the
    // lower one sent a caller that raised its start block to it into a second
    // refusal naming the other.
    const earliestServedBlock = maxBlockAge
      ? currentBlockNumber - maxBlockAge
      : undefined;
    if (
      !isNullish(earliestServedBlock) &&
      startBlock < earliestServedBlock &&
      (isNullish(minBlockNumber) || minBlockNumber <= earliestServedBlock)
    ) {
      throw new LogBlockHistoryUnavailableError(
        `Blocks ${startBlock} to ${endBlock} were requested, but at block height ${currentBlockNumber} a max block age of ${maxBlockAge} leaves this provider serving no block below ${earliestServedBlock}`,
      );
    }
    if (!isNullish(minBlockNumber) && startBlock < minBlockNumber) {
      throw new LogBlockHistoryUnavailableError(
        `Blocks ${startBlock} to ${endBlock} were requested, but this provider serves no block below ${minBlockNumber}`,
      );
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

    // A span of one block leaves endBlock - startBlock at zero, which the loop
    // below would never advance past.
    const blockChunkRange = maxBlockRange || endBlock - startBlock + 1;
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

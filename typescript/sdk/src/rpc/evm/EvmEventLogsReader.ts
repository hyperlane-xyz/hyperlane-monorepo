import { Logger } from 'pino';
import { z } from 'zod';

import { Address, assert, retryAsync, rootLogger } from '@hyperlane-xyz/utils';

import {
  getContractDeploymentTransaction,
  getLogsFromEtherscanLikeExplorerAPI,
} from '../../block-explorer/etherscan.js';
import { assertIsContractAddress } from '../../contracts/contracts.js';
import type { ChainMetadataManager } from '../../metadata/ChainMetadataManager.js';
import { ZBytes32String, ZHash, ZUint } from '../../metadata/customZodTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import type { ChainNameOrId } from '../../types.js';

import { GetEventLogsResponse } from './types.js';
import { getContractCreationBlockFromRpc, getLogsFromRpc } from './utils.js';

export type EvmEventLogsReaderConfig = {
  chain: ChainNameOrId;
  // if true forces the reader to use the rpc to read the timelock data
  // useful for blockchains that do not have a block explorer API
  useRPC?: boolean;
  // Specifies how many blocks can be retrieved to read the logs in a single batch
  paginationBlockRange?: number;
};

export const GetLogByTopicOptionsSchema = z.object({
  eventTopic: ZBytes32String,
  contractAddress: ZHash,
  fromBlock: ZUint.optional(),
  toBlock: ZUint.optional(),
});

export const RequiredGetLogByTopicOptionsSchema =
  GetLogByTopicOptionsSchema.required();

type GetLogByTopicOptions = z.infer<typeof GetLogByTopicOptionsSchema>;
type RequiredGetLogByTopicOptions = z.infer<
  typeof RequiredGetLogByTopicOptionsSchema
>;

// How far below the end of a query the explorer's indexing is re-checked over
// RPC. Explorer indexing lag runs to seconds or minutes, so an hour clears it
// with room for an incident while keeping the re-read to a handful of calls.
const EXPLORER_LAG_TAIL_SECONDS = 60 * 60;

// Used where a chain publishes no block time. Assuming a fast chain overshoots
// on a slow one, costing a few more calls; assuming a slow one would undershoot
// on a fast chain and leave part of the lag window unread.
const ASSUMED_BLOCK_TIME_SECONDS = 1;

// Ceiling on the derived window, so the re-read stays a bounded cost no matter
// how fast a chain is: at the default 500-block RPC page this is about twenty
// calls. It binds only below roughly a third of a second per block, where it
// trades the tail end of the hour for that bound — around forty minutes of
// coverage on the fastest chains, still well beyond observed indexing lag.
const EXPLORER_LAG_TAIL_MAX_BLOCKS = 10_000;

interface IEvmEventLogsReaderStrategy {
  getContractDeploymentBlockNumber(address: Address): Promise<number>;
  getContractLogs(
    address: RequiredGetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]>;
}

export class EvmEtherscanLikeEventLogsReader implements IEvmEventLogsReaderStrategy {
  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly config: Awaited<
      ReturnType<ChainMetadataManager['getExplorerApi']>
    > & { paginationBlockRange?: number },
    protected readonly multiProvider: MultiProvider,
  ) {}

  async getContractDeploymentBlockNumber(address: string): Promise<number> {
    const contractDeploymentTx = await getContractDeploymentTransaction(
      { apiUrl: this.config.apiUrl, apiKey: this.config.apiKey },
      { contractAddress: address },
    );

    const deploymentTransactionReceipt = await this.multiProvider
      .getProvider(this.chain)
      .getTransactionReceipt(contractDeploymentTx.txHash);
    assert(
      deploymentTransactionReceipt?.blockNumber != null,
      `No deployment receipt block number for contract ${address} on ${this.chain}`,
    );

    return deploymentTransactionReceipt.blockNumber;
  }

  // The lag window is a duration, so it is converted into blocks per chain
  // rather than fixed as a block count: the same count is a whole day on a slow
  // chain and minutes on a fast one.
  private lagTailBlocks(): number {
    const { blocks } = this.multiProvider.getChainMetadata(this.chain);
    const estimate = blocks?.estimateBlockTime;
    // The metadata schema already requires this to be positive and finite;
    // re-checking keeps a hand-built metadata object from turning the bounded
    // re-read into a full-range scan.
    const blockTime =
      estimate !== undefined && Number.isFinite(estimate) && estimate > 0
        ? estimate
        : ASSUMED_BLOCK_TIME_SECONDS;

    return Math.min(
      Math.ceil(EXPLORER_LAG_TAIL_SECONDS / blockTime),
      EXPLORER_LAG_TAIL_MAX_BLOCKS,
    );
  }

  /**
   * Reads the explorer's records, and where the query reaches into the recent
   * past also re-reads that part over RPC and merges the two.
   *
   * A page that comes back short proves the explorer has served everything it
   * has indexed, which is not the same as everything up to `toBlock`: an
   * explorer indexing behind the chain reports a stale set as a complete one.
   * Indexing lag only affects blocks near the head, so the re-read covers the
   * intersection of the requested range with the lag window below the head. A
   * query that ends before that window is already settled as far as the explorer
   * is concerned and is left alone — which also keeps historical reads off
   * archive RPC endpoints, since re-reading old blocks would demand one.
   */
  async getContractLogs(
    options: RequiredGetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    const parsedOptions = RequiredGetLogByTopicOptionsSchema.parse(options);

    const explorerLogs = await getLogsFromEtherscanLikeExplorerAPI(
      {
        apiUrl: this.config.apiUrl,
        apiKey: this.config.apiKey,
      },
      {
        address: parsedOptions.contractAddress,
        fromBlock: parsedOptions.fromBlock,
        toBlock: parsedOptions.toBlock,
        topic0: parsedOptions.eventTopic,
      },
    );

    // Anchored to the head rather than to `toBlock`: lag is a property of the
    // chain's tip, so a query that ends well below it has nothing to reconcile.
    // Costs one eth_blockNumber per explorer read, which is cheap next to the
    // explorer request itself and, unlike re-reading old blocks, needs no
    // archive node.
    const headBlock = await this.multiProvider
      .getProvider(this.chain)
      .getBlockNumber();

    // The explorer accounted for every block up to and including the last one
    // it returned a record from. That block is re-read rather than skipped,
    // since a page boundary can fall inside a block; the merge de-duplicates.
    const lastExplorerBlock =
      explorerLogs.length > 0
        ? Math.max(...explorerLogs.map((log) => log.blockNumber))
        : parsedOptions.fromBlock;
    const tailFromBlock = Math.max(
      parsedOptions.fromBlock,
      lastExplorerBlock,
      headBlock - this.lagTailBlocks(),
    );
    const tailToBlock = Math.min(parsedOptions.toBlock, headBlock);

    // The requested range and the lag window do not overlap.
    if (tailFromBlock > tailToBlock) {
      return explorerLogs;
    }

    const tailLogs = await getLogsFromRpc({
      chain: this.chain,
      contractAddress: parsedOptions.contractAddress,
      topic: parsedOptions.eventTopic,
      fromBlock: tailFromBlock,
      toBlock: tailToBlock,
      multiProvider: this.multiProvider,
      // The re-read is an RPC call like any other, so it honours the same
      // per-chain block-range cap the RPC strategy does.
      range: this.config.paginationBlockRange,
    });

    return mergeEventLogs(explorerLogs, tailLogs);
  }
}

// A log is identified by its transaction and its position within it, so a
// record read from both sources is kept once.
function mergeEventLogs(
  ...sources: GetEventLogsResponse[][]
): GetEventLogsResponse[] {
  const byIdentity = new Map<string, GetEventLogsResponse>();
  for (const logs of sources) {
    for (const log of logs) {
      byIdentity.set(`${log.transactionHash}:${log.logIndex}`, log);
    }
  }
  return [...byIdentity.values()];
}

export class EvmRpcEventLogsReader implements IEvmEventLogsReaderStrategy {
  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly config: { paginationBlockRange?: number },
    protected readonly multiProvider: MultiProvider,
  ) {}

  getContractDeploymentBlockNumber(address: string): Promise<number> {
    return getContractCreationBlockFromRpc(
      this.chain,
      address,
      this.multiProvider,
    );
  }

  getContractLogs(
    options: RequiredGetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    const parsedOptions = RequiredGetLogByTopicOptionsSchema.parse(options);

    return getLogsFromRpc({
      chain: this.chain,
      contractAddress: parsedOptions.contractAddress,
      topic: parsedOptions.eventTopic,
      fromBlock: parsedOptions.fromBlock,
      toBlock: parsedOptions.toBlock,
      multiProvider: this.multiProvider,
      range: this.config.paginationBlockRange,
    });
  }
}

export class EvmEventLogsReader {
  private deploymentBlockCache: Map<string, number> = new Map();

  protected constructor(
    protected readonly config: EvmEventLogsReaderConfig,
    protected readonly multiProvider: MultiProvider,
    protected logReaderStrategy: IEvmEventLogsReaderStrategy,
    protected readonly logger: Logger,
    protected fallbackLogReaderStrategy?: IEvmEventLogsReaderStrategy,
  ) {}

  static fromConfig(
    config: EvmEventLogsReaderConfig,
    multiProvider: MultiProvider,
    logger: Logger = rootLogger.child({
      module: EvmEventLogsReader.name,
    }),
  ) {
    const explorer = multiProvider.tryGetEvmExplorerMetadata(config.chain);

    let logReaderStrategy: IEvmEventLogsReaderStrategy;
    let fallbackLogReaderSrategy: IEvmEventLogsReaderStrategy | undefined;
    if (explorer && !config.useRPC) {
      logReaderStrategy = new EvmEtherscanLikeEventLogsReader(
        config.chain,
        {
          apiUrl: explorer.apiUrl,
          apiKey: explorer.apiKey,
          family: explorer.family,
          paginationBlockRange: config.paginationBlockRange,
        },
        multiProvider,
      );

      fallbackLogReaderSrategy = new EvmRpcEventLogsReader(
        config.chain,
        { paginationBlockRange: config.paginationBlockRange },
        multiProvider,
      );
    } else {
      logReaderStrategy = new EvmRpcEventLogsReader(
        config.chain,
        { paginationBlockRange: config.paginationBlockRange },
        multiProvider,
      );
    }

    return new EvmEventLogsReader(
      config,
      multiProvider,
      logReaderStrategy,
      logger,
      fallbackLogReaderSrategy,
    );
  }

  async getLogsByTopic(
    options: GetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    const provider = this.multiProvider.getProvider(this.config.chain);
    await assertIsContractAddress(
      this.multiProvider,
      this.config.chain,
      options.contractAddress,
    );

    try {
      // Retry the primary strategy with exponential backoff to handle
      // transient failures like explorer rate limits
      return await retryAsync(() =>
        this.getLogsByTopicWithStrategy(
          options,
          provider,
          this.logReaderStrategy,
        ),
      );
    } catch (err) {
      if (!this.fallbackLogReaderStrategy) {
        throw err;
      }

      this.logger.debug(
        `Failed to read logs on chain "${this.config.chain}": ${err}. Falling back to using the RPC`,
      );

      return this.getLogsByTopicWithStrategy(
        options,
        provider,
        this.fallbackLogReaderStrategy,
      );
    }
  }

  private async getDeploymentBlock(
    contractAddress: string,
    logReaderStrategy: IEvmEventLogsReaderStrategy,
  ): Promise<number> {
    const cached = this.deploymentBlockCache.get(contractAddress);
    if (cached) return cached;

    const block =
      await logReaderStrategy.getContractDeploymentBlockNumber(contractAddress);
    this.deploymentBlockCache.set(contractAddress, block);
    return block;
  }

  private async getLogsByTopicWithStrategy(
    options: GetLogByTopicOptions,
    provider: ReturnType<MultiProvider['getProvider']>,
    logReaderStrategy: IEvmEventLogsReaderStrategy,
  ): Promise<GetEventLogsResponse[]> {
    const parsedOptions = GetLogByTopicOptionsSchema.parse(options);

    const fromBlock =
      parsedOptions.fromBlock ??
      (await this.getDeploymentBlock(
        parsedOptions.contractAddress,
        logReaderStrategy,
      ));
    const toBlock = parsedOptions.toBlock ?? (await provider.getBlockNumber());

    return logReaderStrategy.getContractLogs({
      contractAddress: parsedOptions.contractAddress,
      eventTopic: parsedOptions.eventTopic,
      fromBlock,
      toBlock,
    });
  }
}

import { Logger } from 'pino';
import { z } from 'zod';

import {
  Address,
  assert,
  isNullish,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

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
  // Explorer-to-explorer fallback by strategy method. Missing options enable
  // fallback; set a method to false to use only the primary explorer.
  explorerFallback?: ExplorerFallbackConfig;
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

function assertLogsMatchQuery(
  logs: GetEventLogsResponse[],
  query: RequiredGetLogByTopicOptions,
): void {
  const expectedAddress = query.contractAddress.toLowerCase();
  const expectedTopic = query.eventTopic.toLowerCase();

  for (const log of logs) {
    assert(
      log.address.toLowerCase() === expectedAddress,
      `Log address ${log.address} does not match requested contract ${query.contractAddress}`,
    );
    assert(
      log.topics[0]?.toLowerCase() === expectedTopic,
      `Log topic does not match requested topic ${query.eventTopic}`,
    );
    assert(
      log.blockNumber >= query.fromBlock && log.blockNumber <= query.toBlock,
      `Log block ${log.blockNumber} is outside requested range ${query.fromBlock}-${query.toBlock}`,
    );
  }
}

interface IEvmEventLogsReaderStrategy {
  getContractDeploymentBlockNumber(address: Address): Promise<number>;
  getContractLogs(
    address: RequiredGetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]>;
}

export type ExplorerFallbackConfig = Partial<
  Record<keyof IEvmEventLogsReaderStrategy, boolean>
>;

export class EvmEtherscanLikeEventLogsReader implements IEvmEventLogsReaderStrategy {
  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly config: Awaited<
      ReturnType<ChainMetadataManager['getExplorerApi']>
    >,
    protected readonly multiProvider: MultiProvider,
  ) {}

  async getContractDeploymentBlockNumber(address: string): Promise<number> {
    const contractDeploymentTx = await getContractDeploymentTransaction(
      { apiUrl: this.config.apiUrl, apiKey: this.config.apiKey },
      { contractAddress: address },
    );

    if (!isNullish(contractDeploymentTx.blockNumber)) {
      return contractDeploymentTx.blockNumber;
    }

    const deploymentTransactionReceipt = await this.multiProvider
      .getProvider(this.chain)
      .getTransactionReceipt(contractDeploymentTx.txHash);
    assert(
      deploymentTransactionReceipt?.blockNumber != null,
      `No deployment receipt block number for contract ${address} on ${this.chain}`,
    );

    return deploymentTransactionReceipt.blockNumber;
  }

  async getContractLogs(
    options: RequiredGetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    const parsedOptions = RequiredGetLogByTopicOptionsSchema.parse(options);

    return getLogsFromEtherscanLikeExplorerAPI(
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
  }
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

class ExplorerFallbackError extends Error {
  readonly isRecoverable: false | undefined;

  constructor(
    chain: ChainNameOrId,
    readonly errors: readonly unknown[],
  ) {
    super(`All configured block explorers failed on chain "${chain}"`, {
      cause: errors.at(-1),
    });
    this.isRecoverable = errors.every(
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        Reflect.get(error, 'isRecoverable') === false,
    )
      ? false
      : undefined;
  }
}

export class FallbackEvmEventLogsReader implements IEvmEventLogsReaderStrategy {
  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly readers: EvmEtherscanLikeEventLogsReader[],
    protected readonly logger: Logger,
    protected readonly config: ExplorerFallbackConfig = {},
  ) {
    assert(readers.length > 0, 'At least one explorer reader is required');
  }

  private async executeWithFallback<T>(
    operation: (reader: EvmEtherscanLikeEventLogsReader) => Promise<T>,
    fallbackEnabled: boolean,
  ): Promise<T> {
    if (!fallbackEnabled) return operation(this.readers[0]);

    const errors: unknown[] = [];
    for (const [explorerIndex, reader] of this.readers.entries()) {
      try {
        return await operation(reader);
      } catch (error) {
        errors.push(error);
        this.logger.debug(
          { err: error, explorerIndex },
          `Block explorer request failed on chain "${this.chain}"`,
        );
      }
    }

    throw new ExplorerFallbackError(this.chain, errors);
  }

  getContractDeploymentBlockNumber(address: Address): Promise<number> {
    return this.executeWithFallback(
      (reader) => reader.getContractDeploymentBlockNumber(address),
      this.config.getContractDeploymentBlockNumber ?? true,
    );
  }

  getContractLogs(
    options: RequiredGetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    return this.executeWithFallback(
      (reader) => reader.getContractLogs(options),
      this.config.getContractLogs ?? true,
    );
  }
}

export class EvmEventLogsReader {
  private deploymentBlockCache: Map<string, number> = new Map();
  private explorerDeploymentBlockCache: Map<string, number> = new Map();

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
    const explorers = config.useRPC
      ? []
      : multiProvider.tryGetEvmExplorerMetadataList(config.chain);
    const explorerReaders = explorers.map(
      (explorer) =>
        new EvmEtherscanLikeEventLogsReader(
          config.chain,
          explorer,
          multiProvider,
        ),
    );

    let logReaderStrategy: IEvmEventLogsReaderStrategy;
    let fallbackLogReaderSrategy: IEvmEventLogsReaderStrategy | undefined;
    if (explorerReaders.length > 0) {
      logReaderStrategy = new FallbackEvmEventLogsReader(
        config.chain,
        explorerReaders,
        logger,
        config.explorerFallback,
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

  async getContractDeploymentBlockFromExplorer(
    contractAddress: Address,
  ): Promise<number> {
    const explorerReader = this.logReaderStrategy;
    assert(
      explorerReader instanceof FallbackEvmEventLogsReader,
      `No block explorer is configured for chain ${this.config.chain}`,
    );

    const cached = this.explorerDeploymentBlockCache.get(contractAddress);
    if (!isNullish(cached)) return cached;

    // Do not use deploymentBlockCache here: an earlier read may have populated
    // it from RPC bisection after an explorer failure.
    const block = await retryAsync(() =>
      explorerReader.getContractDeploymentBlockNumber(contractAddress),
    );
    this.explorerDeploymentBlockCache.set(contractAddress, block);
    this.deploymentBlockCache.set(contractAddress, block);
    return block;
  }

  async getLogsByTopic(
    options: GetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    const parsedOptions = GetLogByTopicOptionsSchema.parse(options);
    const provider = this.multiProvider.getProvider(this.config.chain);
    await assertIsContractAddress(
      this.multiProvider,
      this.config.chain,
      parsedOptions.contractAddress,
    );

    // Every retry and fallback must answer the same block range.
    const resolvedOptions = {
      ...parsedOptions,
      toBlock: parsedOptions.toBlock ?? (await provider.getBlockNumber()),
    };

    try {
      // Retry the primary strategy with exponential backoff to handle
      // transient failures like explorer rate limits
      return await retryAsync(() =>
        this.getLogsByTopicWithStrategy(
          resolvedOptions,
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
        resolvedOptions,
        this.fallbackLogReaderStrategy,
      );
    }
  }

  private async getDeploymentBlock(
    contractAddress: string,
    logReaderStrategy: IEvmEventLogsReaderStrategy,
  ): Promise<number> {
    const cached = this.deploymentBlockCache.get(contractAddress);
    if (!isNullish(cached)) return cached;

    const block =
      await logReaderStrategy.getContractDeploymentBlockNumber(contractAddress);
    this.deploymentBlockCache.set(contractAddress, block);
    return block;
  }

  private async getLogsByTopicWithStrategy(
    options: GetLogByTopicOptions,
    logReaderStrategy: IEvmEventLogsReaderStrategy,
  ): Promise<GetEventLogsResponse[]> {
    const parsedOptions = GetLogByTopicOptionsSchema.parse(options);

    const fromBlock =
      parsedOptions.fromBlock ??
      (await this.getDeploymentBlock(
        parsedOptions.contractAddress,
        logReaderStrategy,
      ));
    assert(
      !isNullish(parsedOptions.toBlock),
      'Expected the log range end to be resolved',
    );
    assert(
      fromBlock <= parsedOptions.toBlock,
      `Log range start ${fromBlock} exceeds end ${parsedOptions.toBlock}`,
    );

    const resolvedOptions = {
      contractAddress: parsedOptions.contractAddress,
      eventTopic: parsedOptions.eventTopic,
      fromBlock,
      toBlock: parsedOptions.toBlock,
    };
    const logs = await logReaderStrategy.getContractLogs(resolvedOptions);
    assertLogsMatchQuery(logs, resolvedOptions);
    return logs;
  }
}

import { Logger } from 'pino';
import { z } from 'zod';

import { Address, rootLogger } from '@hyperlane-xyz/utils';

import {
  getContractDeploymentTransaction,
  getLogsFromEtherscanLikeExplorerAPI,
} from '../../block-explorer/etherscan.js';
import { assertIsContractAddress } from '../../contracts/contracts.js';
import {
  ChainMetadataManager,
  ChainNameOrId,
  MultiProvider,
} from '../../index.js';
import { ZBytes32String, ZHash, ZUint } from '../../metadata/customZodTypes.js';

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

interface IEvmEventLogsReaderStrategy {
  getContractDeploymentBlockNumber(address: Address): Promise<number>;
  getContractLogs(
    address: RequiredGetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]>;
}

export class EvmEtherscanLikeEventLogsReader
  implements IEvmEventLogsReaderStrategy
{
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

    const deploymentTransactionReceipt = await this.multiProvider
      .getProvider(this.chain)
      .getTransactionReceipt(contractDeploymentTx.txHash);

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

export class EvmEventLogsReader {
  protected constructor(
    protected readonly config: EvmEventLogsReaderConfig,
    protected readonly multiProvider: MultiProvider,
    protected logReaderStrategy: IEvmEventLogsReaderStrategy,
    protected readonly logger: Logger,
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
    if (explorer && !config.useRPC) {
      logReaderStrategy = new EvmEtherscanLikeEventLogsReader(
        config.chain,
        explorer,
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
    );
  }

  async getLogsByTopic(
    options: GetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    const parsedOptions = GetLogByTopicOptionsSchema.parse(options);

    const provider = this.multiProvider.getProvider(this.config.chain);
    await assertIsContractAddress(
      this.multiProvider,
      this.config.chain,
      options.contractAddress,
    );

    const fromBlock =
      parsedOptions.fromBlock ??
      (await this.logReaderStrategy.getContractDeploymentBlockNumber(
        parsedOptions.contractAddress,
      ));
    const toBlock = parsedOptions.toBlock ?? (await provider.getBlockNumber());

    return this.logReaderStrategy.getContractLogs({
      contractAddress: parsedOptions.contractAddress,
      eventTopic: parsedOptions.eventTopic,
      fromBlock,
      toBlock,
    });
  }
}

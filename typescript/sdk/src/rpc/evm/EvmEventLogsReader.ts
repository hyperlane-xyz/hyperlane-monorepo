import { Logger } from 'pino';

import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import {
  getContractDeploymentTransaction,
  getLogsFromEtherscanLikeExplorerAPI,
} from '../../block-explorer/etherscan.js';
import {
  ChainMetadataManager,
  ChainNameOrId,
  MultiProvider,
} from '../../index.js';

import { GetEventLogsResponse } from './types.js';
import { getContractCreationBlockFromRpc, getLogsFromRpc } from './utils.js';

type EvmEventLogsReaderConfig = {
  chain: ChainNameOrId;
  useRPC?: boolean;
  logPageSize?: number;
};

type GetLogByTopicOptions = {
  eventTopic: string;
  contractAddress: string;
  fromBlock?: number;
  toBlock?: number;
};

interface IEvmEventLogsReaderStrategy {
  getContractDeploymentBlockNumber(address: Address): Promise<number>;
  getContractLogs(
    address: Required<GetLogByTopicOptions>,
  ): Promise<GetEventLogsResponse[]>;
}

class EvmEtherscanLikeEventLogsReader implements IEvmEventLogsReaderStrategy {
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
    options: Required<GetLogByTopicOptions>,
  ): Promise<GetEventLogsResponse[]> {
    return getLogsFromEtherscanLikeExplorerAPI(
      {
        apiUrl: this.config.apiUrl,
        apiKey: this.config.apiKey,
      },
      {
        address: options.contractAddress,
        fromBlock: options.fromBlock,
        toBlock: options.toBlock,
        topic0: options.eventTopic,
      },
    );
  }
}

class EvmRpcEventLogsReader implements IEvmEventLogsReaderStrategy {
  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly config: { range: number },
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
    options: Required<GetLogByTopicOptions>,
  ): Promise<GetEventLogsResponse[]> {
    return getLogsFromRpc({
      chain: this.chain,
      contractAddress: options.contractAddress,
      topic: options.eventTopic,
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
      multiProvider: this.multiProvider,
      range: this.config.range,
    });
  }
}

// TODO: implement tests for this
export class EvmEventLogsReader {
  protected logReaderStrategy: IEvmEventLogsReaderStrategy;

  constructor(
    protected readonly config: EvmEventLogsReaderConfig,
    protected readonly multiProvider: MultiProvider,
    protected readonly logger: Logger = rootLogger.child({
      module: EvmEventLogsReader.name,
    }),
  ) {
    const explorer = this.multiProvider.tryGetEvmExplorerMetadata(
      this.config.chain,
    );

    if (explorer && !config.useRPC) {
      this.logReaderStrategy = new EvmEtherscanLikeEventLogsReader(
        this.config.chain,
        explorer,
        multiProvider,
      );
    } else {
      this.logReaderStrategy = new EvmRpcEventLogsReader(
        this.config.chain,
        { range: this.config.logPageSize ?? 10_000 },
        this.multiProvider,
      );
    }
  }

  async getLogsByTopic(
    options: GetLogByTopicOptions,
  ): Promise<GetEventLogsResponse[]> {
    const provider = this.multiProvider.getProvider(this.config.chain);

    const contractCode = await provider.getCode(options.contractAddress);
    assert(contractCode !== '0x', '');

    const fromBlock =
      options.fromBlock ??
      (await this.logReaderStrategy.getContractDeploymentBlockNumber(
        options.contractAddress,
      ));
    const toBlock = options.toBlock ?? (await provider.getBlockNumber());

    return this.logReaderStrategy.getContractLogs({
      contractAddress: options.contractAddress,
      eventTopic: options.eventTopic,
      fromBlock,
      toBlock,
    });
  }
}

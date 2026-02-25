import { BlockTag, EtherscanProvider, Networkish } from 'ethers';

import { objFilter, rootLogger, sleep } from '@hyperlane-xyz/utils';

import { BlockExplorer } from '../../metadata/chainMetadataTypes.js';

import {
  IProviderMethods,
  ProviderMethod,
  excludeProviderMethods,
} from './ProviderMethods.js';

const hostToLastQueried: Record<string, number> = {};
const ETHERSCAN_THROTTLE_TIME = 6000;

export class HyperlaneEtherscanProvider
  extends EtherscanProvider
  implements IProviderMethods
{
  protected readonly logger = rootLogger.child({ module: 'EtherscanProvider' });
  public readonly supportedMethods = excludeProviderMethods([
    ProviderMethod.Call,
    ProviderMethod.EstimateGas,
    ProviderMethod.GetGasPrice,
    ProviderMethod.GetTransactionCount,
    ProviderMethod.SendTransaction,
    ProviderMethod.MaxPriorityFeePerGas,
  ]);

  constructor(
    public readonly explorerConfig: BlockExplorer,
    network: Networkish,
    public readonly options?: { debug?: boolean },
  ) {
    super(network, explorerConfig.apiKey);
    if (!explorerConfig.apiKey) {
      this.logger.warn(
        'HyperlaneEtherscanProviders created without an API key will be severely rate limited. Consider using an API key for better reliability.',
      );
    }
  }

  getBaseUrl(): string {
    const apiUrl = this.explorerConfig?.apiUrl;
    if (!apiUrl) throw new Error('Explorer config missing apiUrl');
    if (apiUrl.endsWith('/api')) return apiUrl.slice(0, -4);
    return apiUrl;
  }

  getUrl(module: string, params: Record<string, string>): string {
    const combinedParams = objFilter(params, (k, v): v is string => !!k && !!v);
    combinedParams['module'] = module;
    if (this.apiKey) combinedParams['apikey'] = this.apiKey;
    const parsedParams = new URLSearchParams(combinedParams);
    return `${this.getBaseUrl()}/api?${parsedParams.toString()}`;
  }

  getPostUrl(): string {
    return `${this.getBaseUrl()}/api`;
  }

  getHostname(): string {
    return new URL(this.getBaseUrl()).hostname;
  }

  getQueryWaitTime(): number {
    if (!this.isCommunityResource()) return 0;
    const hostname = this.getHostname();
    const lastExplorerQuery = hostToLastQueried[hostname] || 0;
    return ETHERSCAN_THROTTLE_TIME - (Date.now() - lastExplorerQuery);
  }

  async fetch(
    module: string,
    params: Record<string, any>,
    post?: boolean,
  ): Promise<any> {
    if (!this.isCommunityResource()) return super.fetch(module, params, post);

    const hostname = this.getHostname();
    let waitTime = this.getQueryWaitTime();
    while (waitTime > 0) {
      if (this.options?.debug) {
        this.logger.debug(
          `HyperlaneEtherscanProvider waiting ${waitTime}ms to avoid rate limit`,
        );
      }
      await sleep(waitTime);
      waitTime = this.getQueryWaitTime();
    }

    hostToLastQueried[hostname] = Date.now();
    return super.fetch(module, params, post);
  }

  async perform(method: string, params: any, reqId?: number): Promise<any> {
    if (this.options?.debug) {
      this.logger.debug(
        `HyperlaneEtherscanProvider performing method ${method} for reqId ${reqId}`,
      );
    }
    if (!this.supportedMethods.includes(method as ProviderMethod)) {
      throw new Error(`Unsupported method ${method}`);
    }

    switch (method as ProviderMethod) {
      case ProviderMethod.GetLogs:
        return this.performGetLogs(params);
      case ProviderMethod.GetBlockNumber:
        return this.getBlockNumber();
      case ProviderMethod.GetBlock:
        return this.getBlock(params?.blockTag ?? params?.block ?? 'latest');
      case ProviderMethod.GetBalance:
        return this.getBalance(params?.address, params?.blockTag);
      case ProviderMethod.GetCode:
        return this.getCode(params?.address, params?.blockTag);
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
      default:
        throw new Error(`Unsupported method ${method}`);
    }
  }

  async performGetLogs(params: { filter: any }): Promise<any> {
    const args: Record<string, any> = { action: 'getLogs' };
    if (params.filter.fromBlock) {
      args.fromBlock = checkLogTag(params.filter.fromBlock);
    }
    if (params.filter.toBlock) {
      args.toBlock = checkLogTag(params.filter.toBlock);
    }
    if (params.filter.address) args.address = params.filter.address;
    const topics = params.filter.topics;
    if (topics?.length) {
      if (topics.length > 2) {
        throw new Error(`Unsupported topic count ${topics.length} (max 2)`);
      }
      for (let i = 0; i < topics.length; i++) {
        const topic = topics[i];
        if (!topic || typeof topic !== 'string' || topic.length !== 66) {
          throw new Error(`Unsupported topic format: ${topic}`);
        }
        args[`topic${i}`] = topic;
        if (i < topics.length - 1) args[`topic${i}_${i + 1}_opr`] = 'and';
      }
    }

    return this.fetch('logs', args);
  }
}

function checkLogTag(blockTag: BlockTag): number | 'latest' {
  if (typeof blockTag === 'number') return blockTag;
  if (typeof blockTag === 'bigint') return Number(blockTag);
  if (blockTag === 'pending') throw new Error('pending not supported');
  if (blockTag === 'latest') return blockTag;
  if (typeof blockTag === 'string' && blockTag.startsWith('0x')) {
    return parseInt(blockTag.substring(2), 16);
  }
  return Number(blockTag);
}

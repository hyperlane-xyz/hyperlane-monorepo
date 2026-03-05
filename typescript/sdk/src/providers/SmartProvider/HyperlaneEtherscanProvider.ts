import { rootLogger, sleep } from '@hyperlane-xyz/utils';

import { BlockExplorer } from '../../metadata/chainMetadataTypes.js';

import { IProviderMethods, ProviderMethod } from './ProviderMethods.js';

// Used for crude rate-limiting of explorer queries without API keys
const hostToLastQueried: Record<string, number> = {};
const ETHERSCAN_THROTTLE_TIME = 6000; // 6.0 seconds

type BlockTag = number | string;
type EtherscanFilter = {
  fromBlock?: BlockTag;
  toBlock?: BlockTag;
  address?: string;
  topics?: Array<string | null>;
};
type EtherscanRequestParams = Record<string, string>;
type EtherscanResponseLike = {
  status?: string;
  message?: string;
  result?: unknown;
};
type EtherscanGetLogsParams = { filter: EtherscanFilter };

export class HyperlaneEtherscanProvider implements IProviderMethods {
  protected readonly logger = rootLogger.child({ module: 'EtherscanProvider' });
  public readonly supportedMethods = [ProviderMethod.GetLogs];

  constructor(
    public readonly explorerConfig: BlockExplorer,
    _network: unknown,
    public readonly options?: { debug?: boolean },
  ) {
    if (!explorerConfig.apiKey)
      this.logger.warn(
        'HyperlaneEtherscanProviders created without an API key will be severely rate limited. Consider using an API key for better reliability.',
      );
  }

  get apiKey(): string | undefined {
    return this.explorerConfig.apiKey;
  }

  isCommunityResource(): boolean {
    return !this.apiKey;
  }

  getBaseUrl(): string {
    if (!this.explorerConfig) return ''; // Constructor net yet finished
    const apiUrl = this.explorerConfig?.apiUrl;
    if (!apiUrl) throw new Error('Explorer config missing apiUrl');
    if (apiUrl.endsWith('/api')) return apiUrl.slice(0, -4);
    return apiUrl;
  }

  getUrl(module: string, params: EtherscanRequestParams): string {
    const combinedParams: EtherscanRequestParams = {
      ...params,
      module,
      ...(this.apiKey ? { apikey: this.apiKey } : {}),
    };
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
    params: EtherscanRequestParams,
    post?: boolean,
  ): Promise<unknown> {
    if (this.isCommunityResource()) {
      const hostname = this.getHostname();
      let waitTime = this.getQueryWaitTime();
      while (waitTime > 0) {
        if (this.options?.debug)
          this.logger.debug(
            `HyperlaneEtherscanProvider waiting ${waitTime}ms to avoid rate limit`,
          );
        await sleep(waitTime);
        waitTime = this.getQueryWaitTime();
      }
      hostToLastQueried[hostname] = Date.now();
    }

    const response = await fetch(
      post ? this.getPostUrl() : this.getUrl(module, params),
      post
        ? {
            method: 'POST',
            body: new URLSearchParams(params),
          }
        : undefined,
    );
    const json = parseEtherscanResponse(await response.json());
    if (json.status === '0' && json.message !== 'No records found') {
      throw new Error(
        `Etherscan request failed: ${json.result ?? json.message ?? 'Unknown error'}`,
      );
    }
    return json.result;
  }

  async perform(
    method: string,
    params: unknown,
    reqId?: number,
  ): Promise<unknown> {
    if (this.options?.debug)
      this.logger.debug(
        `HyperlaneEtherscanProvider performing method ${method} for reqId ${reqId}`,
      );
    if (!this.supportedMethods.includes(method as ProviderMethod))
      throw new Error(`Unsupported method ${method}`);

    if (method === ProviderMethod.GetLogs) {
      return this.performGetLogs(toGetLogsParams(params));
    }
    throw new Error(`Unsupported method ${method}`);
  }

  // Overriding to allow more than one topic value
  async performGetLogs(params: EtherscanGetLogsParams): Promise<unknown> {
    const args: EtherscanRequestParams = { action: 'getLogs' };
    if (params.filter.fromBlock)
      args.fromBlock = String(checkLogTag(params.filter.fromBlock));
    if (params.filter.toBlock)
      args.toBlock = String(checkLogTag(params.filter.toBlock));
    if (params.filter.address) args.address = params.filter.address;
    const topics = params.filter.topics;
    if (topics?.length) {
      if (topics.length > 2)
        throw new Error(`Unsupported topic count ${topics.length} (max 2)`);
      for (let i = 0; i < topics.length; i++) {
        const topic = topics[i];
        if (!topic || typeof topic !== 'string' || topic.length !== 66)
          throw new Error(`Unsupported topic format: ${topic}`);
        args[`topic${i}`] = topic;
        if (i < topics.length - 1) args[`topic${i}_${i + 1}_opr`] = 'and';
      }
    }

    return this.fetch('logs', args);
  }
}

function toGetLogsParams(params: unknown): EtherscanGetLogsParams {
  if (!params || typeof params !== 'object') {
    throw new Error('Invalid getLogs params');
  }
  const paramsRecord = params as Record<string, unknown>;
  const filter = paramsRecord.filter;
  if (!filter || typeof filter !== 'object') {
    throw new Error('Invalid getLogs params');
  }
  const filterRecord = filter as Record<string, unknown>;
  return {
    filter: {
      fromBlock:
        typeof filterRecord.fromBlock === 'number' ||
        typeof filterRecord.fromBlock === 'string'
          ? filterRecord.fromBlock
          : undefined,
      toBlock:
        typeof filterRecord.toBlock === 'number' ||
        typeof filterRecord.toBlock === 'string'
          ? filterRecord.toBlock
          : undefined,
      address:
        typeof filterRecord.address === 'string'
          ? filterRecord.address
          : undefined,
      topics: Array.isArray(filterRecord.topics)
        ? filterRecord.topics.filter(
            (t): t is string | null => t === null || typeof t === 'string',
          )
        : undefined,
    },
  };
}

function parseEtherscanResponse(value: unknown): EtherscanResponseLike {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    status: typeof record.status === 'string' ? record.status : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
    result: record.result,
  };
}

// From ethers/providers/src.ts/providers/etherscan-provider.ts
function checkLogTag(blockTag: BlockTag): number | 'latest' {
  if (typeof blockTag === 'number') return blockTag;
  if (blockTag === 'pending') throw new Error('pending not supported');
  if (blockTag === 'latest') return blockTag;
  return parseInt(blockTag.substring(2), 16);
}

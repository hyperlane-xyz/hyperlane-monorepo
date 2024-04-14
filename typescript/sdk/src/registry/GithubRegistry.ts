import { Logger } from 'pino';
import { parse } from 'yaml';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName } from '../types.js';

import { ChainAddresses, IRegistry } from './IRegistry.js';

const DEFAULT_REGISTRY = 'https://github.com/hyperlane-xyz/hyperlane-registry';
const CHAIN_FILE_REGEX = /chains\/([a-z]+)\/([a-z]+)\.yaml/;

export interface GithubRegistryOptions {
  url?: string;
  branch?: string;
  authToken?: string;
  logger?: Logger;
}

interface TreeNode {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
  url: string;
}

interface ChainFiles {
  metadata?: true;
  addresses?: true;
}

interface RepoContent {
  chains: ChainMap<ChainFiles>;
  // TODO add deployment artifacts here
}

export class GithubRegistry implements IRegistry {
  public readonly url: URL;
  public readonly branch: string;
  public readonly repoOwner: string;
  public readonly repoName: string;
  protected readonly logger: Logger;
  // Caches
  protected listCache?: RepoContent;
  protected metadataCache?: ChainMap<ChainMetadata>;
  protected addressCache?: ChainMap<ChainAddresses>;

  constructor(options: GithubRegistryOptions = {}) {
    this.url = new URL(options.url ?? DEFAULT_REGISTRY);
    this.branch = options.branch ?? 'main';
    const pathSegments = this.url.pathname.split('/');
    if (pathSegments.length < 2) throw new Error('Invalid github url');
    this.repoOwner = pathSegments.at(-2)!;
    this.repoName = pathSegments.at(-1)!;
    this.logger =
      options.logger ?? rootLogger.child({ module: 'GithubRegistry' });
  }

  async getChains(): Promise<Array<ChainName>> {
    const repoContents = await this.listRepoFiles();
    return Object.keys(repoContents.chains);
  }

  async getMetadata(): Promise<ChainMap<ChainMetadata>> {
    if (this.metadataCache) return this.metadataCache;
    const chainMetadata: ChainMap<ChainMetadata> = {};
    const repoContents = await this.listRepoFiles();
    for (const [chainName, chainFiles] of Object.entries(repoContents.chains)) {
      if (!chainFiles.metadata) continue;
      const url = this.getRawContentUrl(`chains/${chainName}/metadata.yaml`);
      const response = await this.fetch(url);
      const metadata = parse(await response.text()) as ChainMetadata;
      chainMetadata[chainName] = metadata;
    }
    return (this.metadataCache = chainMetadata);
  }

  async getChainMetadata(chainName: ChainName): Promise<ChainMetadata> {
    if (this.metadataCache?.[chainName]) return this.metadataCache[chainName];
    const url = this.getRawContentUrl(`chains/${chainName}/metadata.yaml`);
    const response = await this.fetch(url);
    return parse(await response.text()) as ChainMetadata;
  }

  async getAddresses(): Promise<ChainMap<ChainAddresses>> {
    if (this.addressCache) return this.addressCache;
    const chainAddresses: ChainMap<ChainAddresses> = {};
    const repoContents = await this.listRepoFiles();
    for (const [chainName, chainFiles] of Object.entries(repoContents.chains)) {
      if (!chainFiles.addresses) continue;
      const url = this.getRawContentUrl(`chains/${chainName}/addresses.yaml`);
      const response = await this.fetch(url);
      const addresses = parse(await response.text()) as ChainAddresses;
      chainAddresses[chainName] = addresses;
    }
    return (this.addressCache = chainAddresses);
  }

  async getChainAddresses(chainName: ChainName): Promise<ChainAddresses> {
    if (this.addressCache?.[chainName]) return this.addressCache[chainName];
    const url = this.getRawContentUrl(`chains/${chainName}/addresses.yaml`);
    const response = await this.fetch(url);
    return parse(await response.text()) as ChainAddresses;
  }

  protected async listRepoFiles(): Promise<RepoContent> {
    if (this.listCache) return this.listCache;

    // This uses the tree API instead of the simpler directory list API because it
    // allows us to get a full view of all files in one request.
    const apiUrl = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/git/trees/${this.branch}?recursive=true`;
    const response = await this.fetch(apiUrl);
    const result = await response.json();
    const tree = result.tree as TreeNode[];

    const chains: ChainMap<ChainFiles> = {};
    for (const node of tree) {
      if (CHAIN_FILE_REGEX.test(node.path)) {
        const [_, chainName, fileName] = node.path.match(CHAIN_FILE_REGEX)!;
        chains[chainName] ??= {};
        if (fileName === 'metadata') chains[chainName].metadata = true;
        if (fileName === 'addresses') chains[chainName].addresses = true;
      }
      // TODO add handling for deployment artifact files here too
    }

    return (this.listCache = { chains });
  }

  protected getRawContentUrl(path: string): string {
    return `https://raw.githubusercontent.com/${this.repoOwner}/${this.repoName}/${this.branch}/${path}`;
  }

  protected async fetch(url: string): Promise<Response> {
    this.logger.debug(`Fetching from github: ${url}`);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(
        `Failed to fetch from github: ${response.status} ${response.statusText}`,
      );
    return response;
  }
}

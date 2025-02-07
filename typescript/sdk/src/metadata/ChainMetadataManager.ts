import { Logger } from 'pino';

import {
  EvmChainId,
  ProtocolType,
  exclude,
  pick,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMap, ChainName, ChainNameOrId } from '../types.js';

import {
  getExplorerAddressUrl,
  getExplorerApi,
  getExplorerApiUrl,
  getExplorerBaseUrl,
  getExplorerTxUrl,
} from './blockExplorer.js';
import {
  ChainMetadata,
  ChainMetadataSchema,
  ExplorerFamily,
  getDomainId,
} from './chainMetadataTypes.js';

export interface ChainMetadataManagerOptions {
  logger?: Logger;
}

/**
 * A set of utilities to manage chain metadata
 * Validates metadata on construction and provides useful methods
 * for interacting with the data
 */
export class ChainMetadataManager<MetaExt = {}> {
  public readonly metadata: ChainMap<ChainMetadata<MetaExt>> = {};
  public readonly logger: Logger;
  static readonly DEFAULT_MAX_BLOCK_RANGE = 1000;

  /**
   * Create a new ChainMetadataManager with the given chainMetadata,
   * or the SDK's default metadata if not provided
   */
  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    options: ChainMetadataManagerOptions = {},
  ) {
    Object.entries(chainMetadata).forEach(([key, cm]) => {
      if (key !== cm.name)
        throw new Error(
          `Chain name mismatch: Key was ${key}, but name is ${cm.name}`,
        );
      this.addChain(cm);
    });
    this.logger =
      options?.logger ||
      rootLogger.child({
        module: 'MetadataManager',
      });
  }

  /**
   * Add a chain to the MultiProvider
   * @throws if chain's name or domain ID collide
   */
  addChain(metadata: ChainMetadata<MetaExt>): void {
    ChainMetadataSchema.parse(metadata);
    // Ensure no two chains have overlapping names/domainIds
    for (const chainMetadata of Object.values(this.metadata)) {
      const { name, domainId } = chainMetadata;
      if (name == metadata.name)
        throw new Error(`Duplicate chain name: ${name}`);
      // Domain Ids should be globally unique
      const idCollision = metadata.domainId && domainId == metadata.domainId;
      if (idCollision)
        throw new Error(`Domain id collision: ${name} and ${metadata.name}`);
    }
    this.metadata[metadata.name] = metadata;
  }

  /**
   * Get the metadata for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  tryGetChainMetadata(
    chainNameOrId: ChainNameOrId,
  ): ChainMetadata<MetaExt> | null {
    // First check if it's a chain name
    if (this.metadata[chainNameOrId]) return this.metadata[chainNameOrId];
    // Otherwise search by domain id
    const chainMetadata = Object.values(this.metadata).find(
      (m) => m.domainId == chainNameOrId,
    );
    return chainMetadata || null;
  }

  /**
   * Get the metadata for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getChainMetadata(chainNameOrId: ChainNameOrId): ChainMetadata<MetaExt> {
    const chainMetadata = this.tryGetChainMetadata(chainNameOrId);
    if (!chainMetadata) {
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    }
    return chainMetadata;
  }

  getMaxBlockRange(chainNameOrId: ChainNameOrId): number {
    const metadata = this.getChainMetadata(chainNameOrId);
    return Math.max(
      ...metadata.rpcUrls.map(
        ({ pagination }) =>
          pagination?.maxBlockRange ??
          ChainMetadataManager.DEFAULT_MAX_BLOCK_RANGE,
      ),
    );
  }

  /**
   * Returns true if the given chain name or domain id is
   * included in this manager's metadata, false otherwise
   */
  hasChain(chainNameOrId: ChainNameOrId): boolean {
    return !!this.tryGetChainMetadata(chainNameOrId);
  }

  /**
   * Get the name for a given chain name or domain id
   */
  tryGetChainName(chainNameOrId: ChainNameOrId): string | null {
    return this.tryGetChainMetadata(chainNameOrId)?.name ?? null;
  }

  /**
   * Get the name for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getChainName(chainNameOrId: ChainNameOrId): string {
    return this.getChainMetadata(chainNameOrId).name;
  }

  /**
   * Get the names for all chains known to this MultiProvider
   */
  getKnownChainNames(): string[] {
    return Object.keys(this.metadata);
  }

  /**
   * Get the id for a given chain name or domain id
   */
  tryGetChainId(chainNameOrId: ChainNameOrId): number | string | null {
    return this.tryGetChainMetadata(chainNameOrId)?.chainId ?? null;
  }

  /**
   * Get the id for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getChainId(chainNameOrId: ChainNameOrId): number | string {
    return this.getChainMetadata(chainNameOrId).chainId;
  }

  /**
   * Get the id for a given EVM chain name or domain id
   * Returns null if chain's metadata has not been set or is not an EVM chain
   */
  tryGetEvmChainId(chainNameOrId: ChainNameOrId): number | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    if (metadata.protocol !== ProtocolType.Ethereum) return null;
    if (typeof metadata.chainId !== 'number') return null;
    return metadata.chainId;
  }

  /**
   * Get the id for a given EVM chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getEvmChainId(chainNameOrId: ChainNameOrId): EvmChainId {
    const { protocol, chainId } = this.getChainMetadata(chainNameOrId);
    if (protocol !== ProtocolType.Ethereum) {
      throw new Error(`Chain is not an EVM chain: ${chainNameOrId}`);
    }
    if (typeof chainId !== 'number') {
      throw new Error(`Chain ID is not a number: ${chainId}`);
    }
    return chainId;
  }

  /**
   * Get the domain id for a given chain name or domain id
   */
  tryGetDomainId(chainNameOrId: ChainNameOrId): number | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    return getDomainId(metadata) ?? null;
  }

  /**
   * Get the domain id for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getDomainId(chainNameOrId: ChainNameOrId): number {
    const domainId = this.tryGetDomainId(chainNameOrId);
    if (!domainId) throw new Error(`No domain id set for ${chainNameOrId}`);
    return domainId;
  }

  /**
   * Get the protocol type for a given chain name or domain id
   */
  tryGetProtocol(chainNameOrId: ChainNameOrId): ProtocolType | null {
    return this.tryGetChainMetadata(chainNameOrId)?.protocol ?? null;
  }

  /**
   * Get the protocol type for a given chain name or domain id
   * @throws if chain's metadata or protocol has not been set
   */
  getProtocol(chainNameOrId: ChainNameOrId): ProtocolType {
    return this.getChainMetadata(chainNameOrId).protocol;
  }

  /**
   * Get the domain ids for a list of chain names or domain ids
   * @throws if any chain's metadata has not been set
   */
  getDomainIds(chainNamesOrIds: Array<ChainName | number>): number[] {
    return chainNamesOrIds.map((c) => this.getDomainId(c));
  }

  /**
   * Get the ids for all chains known to this MultiProvider
   */
  getKnownDomainIds(): number[] {
    return this.getKnownChainNames().map((chainName) =>
      this.getDomainId(chainName),
    );
  }

  /**
   * Get chain names excluding given chain name
   */
  getRemoteChains(name: ChainName): ChainName[] {
    return exclude(name, this.getKnownChainNames());
  }

  /**
   * Run given function on all known chains
   */
  mapKnownChains<Output>(fn: (n: ChainName) => Output): ChainMap<Output> {
    const result: ChainMap<Output> = {};
    for (const chain of this.getKnownChainNames()) {
      result[chain] = fn(chain);
    }
    return result;
  }

  /**
   * Get the RPC details for a given chain name or domain id.
   * Optional index for metadata containing more than one RPC.
   * @throws if chain's metadata has not been set
   */
  getRpc(
    chainNameOrId: ChainNameOrId,
    index = 0,
  ): ChainMetadata['rpcUrls'][number] {
    const { rpcUrls } = this.getChainMetadata(chainNameOrId);
    if (!rpcUrls?.length || !rpcUrls[index])
      throw new Error(
        `No RPC configured at index ${index} for ${chainNameOrId}`,
      );
    return rpcUrls[index];
  }

  /**
   * Get an RPC URL for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getRpcUrl(chainNameOrId: ChainNameOrId, index = 0): string {
    const { http } = this.getRpc(chainNameOrId, index);
    if (!http) throw new Error(`No RPC URL configured for ${chainNameOrId}`);
    return http;
  }

  /**
   * Get an RPC concurrency level for a given chain name or domain id
   */
  tryGetRpcConcurrency(chainNameOrId: ChainNameOrId, index = 0): number | null {
    const { concurrency } = this.getRpc(chainNameOrId, index);
    return concurrency ?? null;
  }

  /**
   * Get a block explorer URL for a given chain name or domain id
   */
  tryGetExplorerUrl(chainNameOrId: ChainNameOrId): string | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    return getExplorerBaseUrl(metadata);
  }

  /**
   * Get a block explorer URL for a given chain name or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerUrl(chainNameOrId: ChainNameOrId): string {
    const url = this.tryGetExplorerUrl(chainNameOrId);
    if (!url) throw new Error(`No explorer url set for ${chainNameOrId}`);
    return url;
  }

  /**
   * Get a block explorer's API for a given chain name or domain id
   */
  tryGetExplorerApi(chainNameOrId: ChainName | number): {
    apiUrl: string;
    apiKey?: string;
    family?: ExplorerFamily;
  } | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    return getExplorerApi(metadata);
  }

  /**
   * Get a block explorer API for a given chain name or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerApi(chainNameOrId: ChainName | number): {
    apiUrl: string;
    apiKey?: string;
    family?: ExplorerFamily;
  } {
    const explorerApi = this.tryGetExplorerApi(chainNameOrId);
    if (!explorerApi)
      throw new Error(`No supported explorer api set for ${chainNameOrId}`);
    return explorerApi;
  }

  /**
   * Get a block explorer's API URL for a given chain name or domain id
   */
  tryGetExplorerApiUrl(chainNameOrId: ChainNameOrId): string | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    return getExplorerApiUrl(metadata);
  }

  /**
   * Get a block explorer API URL for a given chain name or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerApiUrl(chainNameOrId: ChainNameOrId): string {
    const url = this.tryGetExplorerApiUrl(chainNameOrId);
    if (!url) throw new Error(`No explorer api url set for ${chainNameOrId}`);
    return url;
  }

  /**
   * Get a block explorer URL for given chain's tx
   */
  tryGetExplorerTxUrl(
    chainNameOrId: ChainNameOrId,
    response: { hash: string },
  ): string | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    return getExplorerTxUrl(metadata, response.hash);
  }

  /**
   * Get a block explorer URL for given chain's tx
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerTxUrl(
    chainNameOrId: ChainNameOrId,
    response: { hash: string },
  ): string {
    return `${this.getExplorerUrl(chainNameOrId)}/tx/${response.hash}`;
  }

  /**
   * Get a block explorer URL for given chain's address
   */
  async tryGetExplorerAddressUrl(
    chainNameOrId: ChainNameOrId,
    address?: string,
  ): Promise<string | null> {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata || !address) return null;
    return getExplorerAddressUrl(metadata, address);
  }

  /**
   * Get a block explorer URL for given chain's address
   * @throws if address or the chain's block explorer data has no been set
   */
  async getExplorerAddressUrl(
    chainNameOrId: ChainNameOrId,
    address?: string,
  ): Promise<string> {
    const url = await this.tryGetExplorerAddressUrl(chainNameOrId, address);
    if (!url)
      throw new Error(`Missing data for address url for ${chainNameOrId}`);
    return url;
  }

  /**
   * Get native token for given chain
   * @throws if native token has not been set
   */
  async getNativeToken(
    chainNameOrId: ChainNameOrId,
  ): Promise<NonNullable<ChainMetadata['nativeToken']>> {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata || !metadata.nativeToken) {
      throw new Error(`Missing data for native token for ${chainNameOrId}`);
    }
    return metadata.nativeToken;
  }

  /**
   * Creates a new ChainMetadataManager with the extended metadata
   * @param additionalMetadata extra fields to add to the metadata for each chain
   * @returns a new ChainMetadataManager
   */
  extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): ChainMetadataManager<MetaExt & NewExt> {
    const newMetadata: ChainMap<ChainMetadata<MetaExt & NewExt>> = {};
    for (const [name, meta] of Object.entries(this.metadata)) {
      newMetadata[name] = { ...meta, ...additionalMetadata[name] };
    }
    return new ChainMetadataManager(newMetadata);
  }

  /**
   * Create a new instance from the intersection
   * of current's chains and the provided chain list
   */
  intersect(
    chains: ChainName[],
    throwIfNotSubset = false,
  ): {
    intersection: ChainName[];
    result: ChainMetadataManager<MetaExt>;
  } {
    const knownChains = this.getKnownChainNames();
    const intersection: ChainName[] = [];

    for (const chain of chains) {
      if (knownChains.includes(chain)) intersection.push(chain);
      else if (throwIfNotSubset)
        throw new Error(`Known chains does not include ${chain}`);
    }

    if (!intersection.length) {
      throw new Error(
        `No chains shared between known chains and list (${knownChains} and ${chains})`,
      );
    }

    const intersectionMetadata = pick(this.metadata, intersection);
    const result = new ChainMetadataManager(intersectionMetadata);

    return { intersection, result };
  }
}

import { Logger } from 'pino';

import { ProtocolType, exclude, pick, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName, ChainNameOrDomain } from '../types.js';

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
   * @throws if chain's name or domain/chain ID collide
   */
  addChain(metadata: ChainMetadata<MetaExt>): void {
    ChainMetadataSchema.parse(metadata);
    // Ensure no two chains have overlapping names/domainIds/chainIds
    for (const chainMetadata of Object.values(this.metadata)) {
      const { name, chainId, domainId } = chainMetadata;
      if (name == metadata.name)
        throw new Error(`Duplicate chain name: ${name}`);
      // Chain and Domain Ids should be globally unique
      const idCollision =
        chainId == metadata.chainId ||
        domainId == metadata.chainId ||
        (metadata.domainId &&
          (chainId == metadata.domainId || domainId == metadata.domainId));
      if (idCollision)
        throw new Error(
          `Chain/Domain id collision: ${name} and ${metadata.name}`,
        );
    }
    this.metadata[metadata.name] = metadata;
  }

  /**
   * Get the metadata for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  tryGetChainMetadata(
    ChainNameOrDomain: ChainNameOrDomain,
  ): ChainMetadata<MetaExt> | null {
    // First check if it's a chain name
    if (this.metadata[ChainNameOrDomain])
      return this.metadata[ChainNameOrDomain];
    // Otherwise search by chain id and domain id
    const chainMetadata = Object.values(this.metadata).find(
      (m) => m.chainId == ChainNameOrDomain || m.domainId == ChainNameOrDomain,
    );
    return chainMetadata || null;
  }

  /**
   * Get the metadata for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getChainMetadata(
    ChainNameOrDomain: ChainNameOrDomain,
  ): ChainMetadata<MetaExt> {
    const chainMetadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!chainMetadata) {
      throw new Error(`No chain metadata set for ${ChainNameOrDomain}`);
    }
    return chainMetadata;
  }

  getMaxBlockRange(ChainNameOrDomain: ChainNameOrDomain): number {
    const metadata = this.getChainMetadata(ChainNameOrDomain);
    return Math.max(
      ...metadata.rpcUrls.map(
        ({ pagination }) =>
          pagination?.maxBlockRange ??
          ChainMetadataManager.DEFAULT_MAX_BLOCK_RANGE,
      ),
    );
  }

  /**
   * Returns true if the given chain name, chain id, or domain id is
   * include in this manager's metadata, false otherwise
   */
  hasChain(ChainNameOrDomain: ChainNameOrDomain): boolean {
    return !!this.tryGetChainMetadata(ChainNameOrDomain);
  }

  /**
   * Get the name for a given chain name, chain id, or domain id
   */
  tryGetChainName(ChainNameOrDomain: ChainNameOrDomain): string | null {
    return this.tryGetChainMetadata(ChainNameOrDomain)?.name ?? null;
  }

  /**
   * Get the name for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getChainName(ChainNameOrDomain: ChainNameOrDomain): string {
    return this.getChainMetadata(ChainNameOrDomain).name;
  }

  /**
   * Get the names for all chains known to this MultiProvider
   */
  getKnownChainNames(): string[] {
    return Object.keys(this.metadata);
  }

  /**
   * Get the id for a given chain name, chain id, or domain id
   */
  tryGetChainId(ChainNameOrDomain: ChainNameOrDomain): number | string | null {
    return this.tryGetChainMetadata(ChainNameOrDomain)?.chainId ?? null;
  }

  /**
   * Get the id for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getChainId(ChainNameOrDomain: ChainNameOrDomain): number | string {
    return this.getChainMetadata(ChainNameOrDomain).chainId;
  }

  /**
   * Get the ids for all chains known to this MultiProvider
   */
  getKnownChainIds(): Array<number | string> {
    return Object.values(this.metadata).map((c) => c.chainId);
  }

  /**
   * Get the domain id for a given chain name, chain id, or domain id
   */
  tryGetDomainId(ChainNameOrDomain: ChainNameOrDomain): number | null {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!metadata) return null;
    return getDomainId(metadata) ?? null;
  }

  /**
   * Get the domain id for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getDomainId(ChainNameOrDomain: ChainNameOrDomain): number {
    const domainId = this.tryGetDomainId(ChainNameOrDomain);
    if (!domainId) throw new Error(`No domain id set for ${ChainNameOrDomain}`);
    return domainId;
  }

  /**
   * Get the protocol type for a given chain name, chain id, or domain id
   */
  tryGetProtocol(ChainNameOrDomain: ChainNameOrDomain): ProtocolType | null {
    return this.tryGetChainMetadata(ChainNameOrDomain)?.protocol ?? null;
  }

  /**
   * Get the protocol type for a given chain name, chain id, or domain id
   * @throws if chain's metadata or protocol has not been set
   */
  getProtocol(ChainNameOrDomain: ChainNameOrDomain): ProtocolType {
    return this.getChainMetadata(ChainNameOrDomain).protocol;
  }

  /**
   * Get the domain ids for a list of chain names, chain ids, or domain ids
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
   * Get the RPC details for a given chain name, chain id, or domain id.
   * Optional index for metadata containing more than one RPC.
   * @throws if chain's metadata has not been set
   */
  getRpc(
    ChainNameOrDomain: ChainNameOrDomain,
    index = 0,
  ): ChainMetadata['rpcUrls'][number] {
    const { rpcUrls } = this.getChainMetadata(ChainNameOrDomain);
    if (!rpcUrls?.length || !rpcUrls[index])
      throw new Error(
        `No RPC configured at index ${index} for ${ChainNameOrDomain}`,
      );
    return rpcUrls[index];
  }

  /**
   * Get an RPC URL for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getRpcUrl(ChainNameOrDomain: ChainNameOrDomain, index = 0): string {
    const { http } = this.getRpc(ChainNameOrDomain, index);
    if (!http)
      throw new Error(`No RPC URL configured for ${ChainNameOrDomain}`);
    return http;
  }

  /**
   * Get an RPC concurrency level for a given chain name, chain id, or domain id
   */
  tryGetRpcConcurrency(
    ChainNameOrDomain: ChainNameOrDomain,
    index = 0,
  ): number | null {
    const { concurrency } = this.getRpc(ChainNameOrDomain, index);
    return concurrency ?? null;
  }

  /**
   * Get a block explorer URL for a given chain name, chain id, or domain id
   */
  tryGetExplorerUrl(ChainNameOrDomain: ChainNameOrDomain): string | null {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!metadata) return null;
    return getExplorerBaseUrl(metadata);
  }

  /**
   * Get a block explorer URL for a given chain name, chain id, or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerUrl(ChainNameOrDomain: ChainNameOrDomain): string {
    const url = this.tryGetExplorerUrl(ChainNameOrDomain);
    if (!url) throw new Error(`No explorer url set for ${ChainNameOrDomain}`);
    return url;
  }

  /**
   * Get a block explorer's API for a given chain name, chain id, or domain id
   */
  tryGetExplorerApi(ChainNameOrDomain: ChainName | number): {
    apiUrl: string;
    apiKey?: string;
    family?: ExplorerFamily;
  } | null {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!metadata) return null;
    return getExplorerApi(metadata);
  }

  /**
   * Get a block explorer API for a given chain name, chain id, or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerApi(ChainNameOrDomain: ChainName | number): {
    apiUrl: string;
    apiKey?: string;
    family?: ExplorerFamily;
  } {
    const explorerApi = this.tryGetExplorerApi(ChainNameOrDomain);
    if (!explorerApi)
      throw new Error(`No supported explorer api set for ${ChainNameOrDomain}`);
    return explorerApi;
  }

  /**
   * Get a block explorer's API URL for a given chain name, chain id, or domain id
   */
  tryGetExplorerApiUrl(ChainNameOrDomain: ChainNameOrDomain): string | null {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!metadata) return null;
    return getExplorerApiUrl(metadata);
  }

  /**
   * Get a block explorer API URL for a given chain name, chain id, or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerApiUrl(ChainNameOrDomain: ChainNameOrDomain): string {
    const url = this.tryGetExplorerApiUrl(ChainNameOrDomain);
    if (!url)
      throw new Error(`No explorer api url set for ${ChainNameOrDomain}`);
    return url;
  }

  /**
   * Get a block explorer URL for given chain's tx
   */
  tryGetExplorerTxUrl(
    ChainNameOrDomain: ChainNameOrDomain,
    response: { hash: string },
  ): string | null {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!metadata) return null;
    return getExplorerTxUrl(metadata, response.hash);
  }

  /**
   * Get a block explorer URL for given chain's tx
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerTxUrl(
    ChainNameOrDomain: ChainNameOrDomain,
    response: { hash: string },
  ): string {
    return `${this.getExplorerUrl(ChainNameOrDomain)}/tx/${response.hash}`;
  }

  /**
   * Get a block explorer URL for given chain's address
   */
  async tryGetExplorerAddressUrl(
    ChainNameOrDomain: ChainNameOrDomain,
    address?: string,
  ): Promise<string | null> {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!metadata || !address) return null;
    return getExplorerAddressUrl(metadata, address);
  }

  /**
   * Get a block explorer URL for given chain's address
   * @throws if address or the chain's block explorer data has no been set
   */
  async getExplorerAddressUrl(
    ChainNameOrDomain: ChainNameOrDomain,
    address?: string,
  ): Promise<string> {
    const url = await this.tryGetExplorerAddressUrl(ChainNameOrDomain, address);
    if (!url)
      throw new Error(`Missing data for address url for ${ChainNameOrDomain}`);
    return url;
  }

  /**
   * Get native token for given chain
   * @throws if native token has not been set
   */
  async getNativeToken(
    ChainNameOrDomain: ChainNameOrDomain,
  ): Promise<NonNullable<ChainMetadata['nativeToken']>> {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
    if (!metadata || !metadata.nativeToken) {
      throw new Error(`Missing data for native token for ${ChainNameOrDomain}`);
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

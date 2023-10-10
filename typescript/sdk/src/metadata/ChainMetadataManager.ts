import { Debugger, debug } from 'debug';

import { ProtocolType, exclude, isNumeric, pick } from '@hyperlane-xyz/utils';

import {
  chainMetadata as defaultChainMetadata,
  solanaChainToClusterName,
} from '../consts/chainMetadata';
import { ChainMap, ChainName } from '../types';

import {
  ChainMetadata,
  getDomainId,
  isValidChainMetadata,
} from './chainMetadataTypes';

export interface ChainMetadataManagerOptions {
  loggerName?: string;
}

/**
 * A set of utilities to manage chain metadata
 * Validates metadata on construction and provides useful methods
 * for interacting with the data
 */
export class ChainMetadataManager<MetaExt = {}> {
  public readonly metadata: ChainMap<ChainMetadata<MetaExt>> = {};
  public readonly logger: Debugger;

  /**
   * Create a new ChainMetadataManager with the given chainMetadata,
   * or the SDK's default metadata if not provided
   */
  constructor(
    chainMetadata: ChainMap<
      ChainMetadata<MetaExt>
    > = defaultChainMetadata as ChainMap<ChainMetadata<MetaExt>>,
    options: ChainMetadataManagerOptions = {},
  ) {
    Object.entries(chainMetadata).forEach(([key, cm]) => {
      if (key !== cm.name)
        throw new Error(
          `Chain name mismatch: Key was ${key}, but name is ${cm.name}`,
        );
      this.addChain(cm);
    });
    this.logger = debug(options?.loggerName || 'hyperlane:MetadataManager');
  }

  /**
   * Add a chain to the MultiProvider
   * @throws if chain's name or domain/chain ID collide
   */
  addChain(metadata: ChainMetadata<MetaExt>): void {
    if (!isValidChainMetadata(metadata))
      throw new Error(`Invalid chain metadata for ${metadata.name}`);
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
          (chainId == metadata.domainId || domainId === metadata.domainId));
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
    chainNameOrId: ChainName | number,
  ): ChainMetadata<MetaExt> | null {
    let chainMetadata: ChainMetadata<MetaExt> | undefined;
    if (isNumeric(chainNameOrId)) {
      // Should be chain id or domain id
      chainMetadata = Object.values(this.metadata).find(
        (m) => m.chainId == chainNameOrId || m.domainId == chainNameOrId,
      );
    } else if (typeof chainNameOrId === 'string') {
      // Should be chain name
      chainMetadata = this.metadata[chainNameOrId];
    }
    return chainMetadata || null;
  }

  /**
   * Get the metadata for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getChainMetadata(chainNameOrId: ChainName | number): ChainMetadata<MetaExt> {
    const chainMetadata = this.tryGetChainMetadata(chainNameOrId);
    if (!chainMetadata) {
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    }
    return chainMetadata;
  }

  /**
   * Get the name for a given chain name, chain id, or domain id
   */
  tryGetChainName(chainNameOrId: ChainName | number): string | null {
    return this.tryGetChainMetadata(chainNameOrId)?.name ?? null;
  }

  /**
   * Get the name for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getChainName(chainNameOrId: ChainName | number): string {
    return this.getChainMetadata(chainNameOrId).name;
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
  tryGetChainId(chainNameOrId: ChainName | number): number | null {
    return this.tryGetChainMetadata(chainNameOrId)?.chainId ?? null;
  }

  /**
   * Get the id for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getChainId(chainNameOrId: ChainName | number): number {
    return this.getChainMetadata(chainNameOrId).chainId;
  }

  /**
   * Get the ids for all chains known to this MultiProvider
   */
  getKnownChainIds(): number[] {
    return Object.values(this.metadata).map((c) => c.chainId);
  }

  /**
   * Get the domain id for a given chain name, chain id, or domain id
   */
  tryGetDomainId(chainNameOrId: ChainName | number): number | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    return metadata?.domainId ?? metadata?.chainId ?? null;
  }

  /**
   * Get the domain id for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getDomainId(chainNameOrId: ChainName | number): number {
    const metadata = this.getChainMetadata(chainNameOrId);
    return getDomainId(metadata);
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
    return this.getKnownChainNames().map(this.getDomainId);
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
   * Get an RPC URL for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getRpcUrl(chainNameOrId: ChainName | number): string {
    const { rpcUrls } = this.getChainMetadata(chainNameOrId);
    if (!rpcUrls?.length || !rpcUrls[0].http)
      throw new Error(`No RPC URl configured for ${chainNameOrId}`);
    return rpcUrls[0].http;
  }

  /**
   * Get a block explorer URL for a given chain name, chain id, or domain id
   */
  tryGetExplorerUrl(chainNameOrId: ChainName | number): string | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata?.blockExplorers?.length) return null;
    const url = new URL(metadata.blockExplorers[0].url);
    // TODO move handling of these chain/protocol specific quirks to ChainMetadata
    if (
      metadata.protocol === ProtocolType.Sealevel &&
      solanaChainToClusterName[metadata.name]
    ) {
      url.searchParams.set('cluster', solanaChainToClusterName[metadata.name]);
    }
    return url.toString();
  }

  /**
   * Get a block explorer URL for a given chain name, chain id, or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerUrl(chainNameOrId: ChainName | number): string {
    const url = this.tryGetExplorerUrl(chainNameOrId);
    if (!url) throw new Error(`No explorer url set for ${chainNameOrId}`);
    return url;
  }

  /**
   * Get a block explorer's API URL for a given chain name, chain id, or domain id
   */
  tryGetExplorerApiUrl(chainNameOrId: ChainName | number): string | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    const { protocol, blockExplorers } = metadata || {};
    if (protocol !== ProtocolType.Ethereum) return null;
    if (!blockExplorers?.length || !blockExplorers[0].apiUrl) return null;
    const { apiUrl, apiKey } = blockExplorers[0];
    if (!apiKey) return apiUrl;
    const url = new URL(apiUrl);
    url.searchParams.set('apikey', apiKey);
    return url.toString();
  }

  /**
   * Get a block explorer API URL for a given chain name, chain id, or domain id
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerApiUrl(chainNameOrId: ChainName | number): string {
    const url = this.tryGetExplorerApiUrl(chainNameOrId);
    if (!url) throw new Error(`No explorer api url set for ${chainNameOrId}`);
    return url;
  }

  /**
   * Get a block explorer URL for given chain's tx
   */
  tryGetExplorerTxUrl(
    chainNameOrId: ChainName | number,
    response: { hash: string },
  ): string | null {
    const baseUrl = this.tryGetExplorerUrl(chainNameOrId);
    if (!baseUrl) return null;
    const chainName = this.getChainName(chainNameOrId);
    const urlPathStub = ['nautilus', 'proteustestnet'].includes(chainName)
      ? 'transaction'
      : 'tx';
    const url = new URL(baseUrl);
    url.pathname += `/${urlPathStub}/${response.hash}`;
    return url.toString();
  }

  /**
   * Get a block explorer URL for given chain's address
   */
  async tryGetExplorerAddressUrl(
    chainNameOrId: ChainName | number,
    address?: string,
  ): Promise<string | null> {
    if (!address) return null;
    const baseUrl = this.tryGetExplorerUrl(chainNameOrId);
    if (!baseUrl) return null;
    const url = new URL(baseUrl);
    url.pathname += `/address/${address}`;
    return url.toString();
  }

  /**
   * Get a block explorer URL for given chain's address
   * @throws if address or the chain's block explorer data has no been set
   */
  async getExplorerAddressUrl(
    chainNameOrId: ChainName | number,
    address?: string,
  ): Promise<string> {
    const url = await this.tryGetExplorerAddressUrl(chainNameOrId, address);
    if (!url)
      throw new Error(`Missing data for address url for ${chainNameOrId}`);
    return url;
  }

  /**
   * Get a block explorer URL for given chain's tx
   * @throws if chain's metadata or block explorer data has no been set
   */
  getExplorerTxUrl(
    chainNameOrId: ChainName | number,
    response: { hash: string },
  ): string {
    return `${this.getExplorerUrl(chainNameOrId)}/tx/${response.hash}`;
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
      if (!additionalMetadata[name])
        throw new Error(`No additional data provided for chain ${name}`);
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

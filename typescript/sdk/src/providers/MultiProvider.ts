import { Signer, providers } from 'ethers';

import { ChainMetadata, chainMetadata } from '../consts/chainMetadata';
import { ChainMap, ChainName } from '../types';
import { pick } from '../utils/objects';

type Provider = providers.Provider;

interface Params {
  metadata?: ChainMap<ChainMetadata>;
  providers?: ChainMap<Provider>;
  signers?: ChainMap<Signer>;
}

export class MultiProvider {
  public readonly metadata: ChainMap<ChainMetadata>;
  private readonly providers: ChainMap<Provider>;
  private readonly signers: ChainMap<Signer>;

  constructor({ metadata, providers, signers }: Params = {}) {
    this.metadata = metadata ?? chainMetadata;
    this.providers = providers ?? {};
    this.signers = signers ?? {};
  }

  /**
   * Get the metadata for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  tryGetChainMetadata(chainNameOrId: ChainName | number): ChainMetadata | null {
    let chainMetadata: ChainMetadata | undefined;
    if (typeof chainNameOrId === 'string') {
      chainMetadata = this.metadata[chainNameOrId];
    } else {
      chainMetadata = Object.values(this.metadata).find(
        (m) => m.id === chainNameOrId,
      );
    }
    return chainMetadata || null;
  }

  /**
   * Get the metadata for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  getChainMetadata(chainNameOrId: ChainName | number): ChainMetadata {
    const chainMetadata = this.tryGetChainMetadata(chainNameOrId);
    if (!chainMetadata)
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    return chainMetadata;
  }

  /**
   * Get the name for a given chain name or id
   */
  tryGetChainName(chainNameOrId: ChainName | number): string | null {
    return this.tryGetChainMetadata(chainNameOrId)?.name ?? null;
  }

  /**
   * Get the name for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  getChainName(chainNameOrId: ChainName | number): string {
    return this.getChainMetadata(chainNameOrId).name;
  }

  /**
   * Get the names for all chains known to this MultiProvider
   */
  getChainNames(): string[] {
    return Object.keys(this.metadata);
  }

  /**
   * Get the id for a given chain name or id
   */
  tryGetChainId(chainNameOrId: ChainName | number): number | null {
    return this.tryGetChainMetadata(chainNameOrId)?.id ?? null;
  }

  /**
   * Get the id for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  getChainId(chainNameOrId: ChainName | number): number {
    return this.getChainMetadata(chainNameOrId).id;
  }

  /**
   * Get the ids for all chains known to this MultiProvider
   */
  getChainIds(): number[] {
    return Object.values(this.metadata).map((c) => c.id);
  }

  /**
   * Get the domain id for a given chain name or id
   */
  tryGetDomainId(chainNameOrId: ChainName | number): number | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    return metadata?.domainId ?? metadata?.id ?? null;
  }

  /**
   * Get the domain id for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  getDomainId(chainNameOrId: ChainName | number): number {
    const metadata = this.getChainMetadata(chainNameOrId);
    return metadata.domainId ?? metadata.id;
  }

  /**
   * Get the ids for all chains known to this MultiProvider
   */
  getDomainIds(): number[] {
    return this.getChainNames().map(this.getDomainId);
  }

  /**
   * Get the chain name for a given domain id
   */
  domainIdToChainName(domainId: number): string {
    const metadataList = Object.values(this.metadata);
    const metadata =
      metadataList.find((c) => c.domainId === domainId) ||
      metadataList.find((c) => c.id === domainId);
    if (!metadata) throw new Error(`No chain found for domain id ${domainId}`);
    return metadata.name;
  }

  /**
   * Get the chain id for a given domain id
   */
  domainIdToChainId(domainId: number): number {
    const chainName = this.domainIdToChainName(domainId);
    return this.getChainId(chainName);
  }

  /**
   * Get an Ethers provider for a given chain name or id
   */
  tryGetProvider(chainNameOrId: ChainName | number): Provider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (metadata && this.providers[metadata.name])
      return this.providers[metadata.name];
    if (!metadata?.publicRpcUrls.length) return null;
    return new providers.JsonRpcProvider(
      metadata.publicRpcUrls[0].http,
      metadata.id,
    );
  }

  /**
   * Get an Ethers provider for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  getProvider(chainNameOrId: ChainName | number): Provider {
    const provider = this.tryGetProvider(chainNameOrId);
    if (!provider)
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    return provider;
  }

  /**
   * Sets an Ethers provider for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  setProvider(chainNameOrId: ChainName | number, provider: Provider): Provider {
    const chainName = this.getChainName(chainNameOrId);
    this.providers[chainName] = provider;
    return provider;
  }

  /**
   * Get an Ethers signer for a given chain name or id
   */
  tryGetSigner(chainNameOrId: ChainName | number): Signer | null {
    const chainName = this.tryGetChainName(chainNameOrId);
    if (chainName && this.signers[chainName]) return this.signers[chainName];
    return null;
  }

  /**
   * Get an Ethers signer for a given chain name or id
   * @throws if chain's metadata or signer has not been set
   */
  getSigner(chainNameOrId: ChainName | number): Signer {
    const chainName = this.getChainName(chainNameOrId);
    if (this.signers[chainName]) return this.signers[chainName];
    else throw new Error(`No chain signer set for ${chainNameOrId}`);
  }

  /**
   * Sets an Ethers Signer for a given chain name or id
   * @throws if chain's metadata has not been set
   */
  setSigner(chainNameOrId: ChainName | number, signer: Signer): Signer {
    const chainName = this.getChainName(chainNameOrId);
    this.signers[chainName] = signer;
    return signer;
  }

  /**
   * Create a new MultiProvider from the intersection
   * of current's chains and the provided chain list
   */
  intersect(
    chains: ChainName[],
    throwIfNotSubset = false,
  ): {
    intersection: ChainName[];
    multiProvider: MultiProvider;
  } {
    const ownChains = this.getChainNames();
    const intersection: ChainName[] = [];

    for (const chain of chains) {
      if (ownChains.includes(chain)) {
        intersection.push(chain);
      } else if (throwIfNotSubset) {
        throw new Error(
          `MultiProvider#intersect: chains specified ${chain}, but ownChains did not include it`,
        );
      }
    }

    if (!intersection.length) {
      throw new Error(
        `No chains shared between MultiProvider and list (${ownChains} and ${chains})`,
      );
    }

    const intersectionMetadata = pick(this.metadata, intersection);
    const intersectionProviders = pick(this.providers, intersection);
    const intersectionSigners = pick(this.signers, intersection);

    const multiProvider = new MultiProvider({
      metadata: intersectionMetadata,
      providers: intersectionProviders,
      signers: intersectionSigners,
    });
    return { intersection, multiProvider };
  }

  // rotateSigner(newSigner: Signer): void {
  //   this.forEach((chain, dc) => {
  //     this.setChainConnection(chain, {
  //       ...dc,
  //       signer: newSigner.connect(dc.provider),
  //     });
  //   });
  // }
}

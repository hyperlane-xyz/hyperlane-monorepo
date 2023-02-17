import { Debugger, debug } from 'debug';
import {
  BigNumber,
  ContractReceipt,
  ContractTransaction,
  PopulatedTransaction,
  Signer,
  providers,
} from 'ethers';

import { types } from '@hyperlane-xyz/utils';

import {
  ChainMetadata,
  chainMetadata as defaultChainMetadata,
} from '../consts/chainMetadata';
import { CoreChainName, TestChains } from '../consts/chains';
import { ChainMap, ChainName } from '../types';
import { pick } from '../utils/objects';

type Provider = providers.Provider;

export class MultiProvider {
  private readonly logger: Debugger = debug('hyperlane:MultiProvider');
  public readonly metadata: ChainMap<ChainMetadata> = {};
  private readonly providers: ChainMap<Provider> = {};
  private signers: ChainMap<Signer> = {};
  private useSharedSigner = false; // A single signer to be used for all chains

  /**
   * Create a new MultiProvider with the given chainMetadata,
   * or the SDK's default metadata if not provided
   */
  constructor(chainMetadata: ChainMap<ChainMetadata> = defaultChainMetadata) {
    this.metadata = chainMetadata;
    // Ensure no two chains have overlapping names/domainIds/chainIds
    const chainNames = new Set<string>();
    const chainIds = new Set<number>();
    const domainIds = new Set<number>();
    for (const chain of Object.values(chainMetadata)) {
      const { name, chainId, domainId } = chain;
      if (chainNames.has(name))
        throw new Error(`Duplicate chain name: ${name}`);
      if (chainIds.has(chainId))
        throw new Error(`Duplicate chain id: ${chainId}`);
      if (domainIds.has(chainId))
        throw new Error(`Overlapping chain/domain id: ${chainId}`);
      if (domainId && domainIds.has(domainId))
        throw new Error(`Duplicate domain id: ${domainId}`);
      if (domainId && chainIds.has(domainId))
        throw new Error(`Overlapping chain/domain id: ${domainId}`);
      chainNames.add(name);
      chainIds.add(chainId);
      if (domainId) domainIds.add(domainId);
    }
  }

  /**
   * Get the metadata for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  tryGetChainMetadata(chainNameOrId: ChainName | number): ChainMetadata | null {
    let chainMetadata: ChainMetadata | undefined;
    if (typeof chainNameOrId === 'string') {
      chainMetadata = this.metadata[chainNameOrId];
    } else if (typeof chainNameOrId === 'number') {
      chainMetadata = Object.values(this.metadata).find(
        (m) => m.chainId === chainNameOrId || m.domainId === chainNameOrId,
      );
    }
    return chainMetadata || null;
  }

  /**
   * Get the metadata for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getChainMetadata(chainNameOrId: ChainName | number): ChainMetadata {
    const chainMetadata = this.tryGetChainMetadata(chainNameOrId);
    if (!chainMetadata)
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
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
    return metadata.domainId ?? metadata.chainId;
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
   * Get an Ethers provider for a given chain name, chain id, or domain id
   */
  tryGetProvider(chainNameOrId: ChainName | number): Provider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { name, chainId: id, publicRpcUrls } = metadata;

    if (this.providers[name]) return this.providers[name];

    if (TestChains.includes(name as CoreChainName)) {
      this.providers[name] = new providers.JsonRpcProvider(
        'http://localhost:8545',
        31337,
      );
    } else if (publicRpcUrls.length && publicRpcUrls[0].http) {
      this.providers[name] = new providers.JsonRpcProvider(
        publicRpcUrls[0].http,
        id,
      );
    } else {
      return null;
    }

    return this.providers[name];
  }

  /**
   * Get an Ethers provider for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  getProvider(chainNameOrId: ChainName | number): Provider {
    const provider = this.tryGetProvider(chainNameOrId);
    if (!provider)
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    return provider;
  }

  /**
   * Sets an Ethers provider for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set
   */
  setProvider(chainNameOrId: ChainName | number, provider: Provider): Provider {
    const chainName = this.getChainName(chainNameOrId);
    this.providers[chainName] = provider;
    return provider;
  }

  /**
   * Sets Ethers providers for a set of chains
   * @throws if chain's metadata has not been set
   */
  setProviders(providers: ChainMap<Provider>): void {
    for (const chain of Object.keys(providers)) {
      const chainName = this.getChainName(chain);
      this.providers[chainName] = providers[chain];
    }
  }

  /**
   * Get an Ethers signer for a given chain name, chain id, or domain id
   * If signer is not yet connected, it will be connected
   */
  tryGetSigner(chainNameOrId: ChainName | number): Signer | null {
    const chainName = this.tryGetChainName(chainNameOrId);
    if (!chainName) return null;

    // Otherwise check the chain-to-signer map
    const signer = this.signers[chainName];
    if (!signer) return null;
    if (signer.provider) return signer;
    // Auto-connect the signer for convenience
    const provider = this.tryGetProvider(chainName);
    return provider ? signer.connect(provider) : signer;
  }

  /**
   * Get an Ethers signer for a given chain name, chain id, or domain id
   * If signer is not yet connected, it will be connected
   * @throws if chain's metadata or signer has not been set
   */
  getSigner(chainNameOrId: ChainName | number): Signer {
    const signer = this.tryGetSigner(chainNameOrId);
    if (!signer) throw new Error(`No chain signer set for ${chainNameOrId}`);
    return signer;
  }

  /**
   * Get an Ethers signer for a given chain name, chain id, or domain id
   * @throws if chain's metadata or signer has not been set
   */
  async getSignerAddress(
    chainNameOrId: ChainName | number,
  ): Promise<types.Address> {
    const signer = this.getSigner(chainNameOrId);
    const address = await signer.getAddress();
    return address;
  }

  /**
   * Sets an Ethers Signer for a given chain name, chain id, or domain id
   * @throws if chain's metadata has not been set or shared signer has already been set
   */
  setSigner(chainNameOrId: ChainName | number, signer: Signer): Signer {
    if (this.useSharedSigner) {
      throw new Error('MultiProvider already set to use a shared signer');
    }
    const chainName = this.getChainName(chainNameOrId);
    this.signers[chainName] = signer;
    if (signer.provider && !this.providers[chainName]) {
      this.providers[chainName] = signer.provider;
    }
    return signer;
  }

  /**
   * Sets Ethers Signers for a set of chains
   * @throws if chain's metadata has not been set or shared signer has already been set
   */
  setSigners(signers: ChainMap<Signer>): void {
    if (this.useSharedSigner) {
      throw new Error('MultiProvider already set to use a shared signer');
    }
    for (const chain of Object.keys(signers)) {
      const chainName = this.getChainName(chain);
      this.signers[chainName] = signers[chain];
    }
  }

  /**
   * Gets the Signer if it's been set, otherwise the provider
   */
  tryGetSignerOrProvider(
    chainNameOrId: ChainName | number,
  ): Signer | Provider | null {
    return (
      this.tryGetSigner(chainNameOrId) || this.tryGetProvider(chainNameOrId)
    );
  }

  /**
   * Gets the Signer if it's been set, otherwise the provider
   * @throws if chain metadata has not been set
   */
  getSignerOrProvider(chainNameOrId: ChainName | number): Signer | Provider {
    return this.tryGetSigner(chainNameOrId) || this.getProvider(chainNameOrId);
  }

  /**
   * Sets Ethers Signers to be used for all chains
   * Any subsequent calls to getSigner will return given signer
   * Setting sharedSigner to null clears all signers
   */
  setSharedSigner(sharedSigner: Signer | null): Signer | null {
    if (!sharedSigner) {
      this.useSharedSigner = false;
      this.signers = {};
      return null;
    }
    this.useSharedSigner = true;
    for (const chain of this.getKnownChainNames()) {
      this.signers[chain] = sharedSigner;
    }
    return sharedSigner;
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
    const ownChains = this.getKnownChainNames();
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
    const multiProvider = new MultiProvider(intersectionMetadata);
    multiProvider.setProviders(intersectionProviders);
    multiProvider.setSigners(intersectionSigners);

    return { intersection, multiProvider };
  }

  /**
   * Get chain names excluding given chain name
   */
  getRemoteChains(name: ChainName): ChainName[] {
    return this.getKnownChainNames().filter((n) => n !== name);
  }

  /**
   * Get an RPC URL for given chain
   * @throws if chain's metadata has not been set
   */
  getRpcUrl(chainNameOrId: ChainName | number): string {
    const { publicRpcUrls } = this.getChainMetadata(chainNameOrId);
    if (!publicRpcUrls?.length || !publicRpcUrls[0].http)
      throw new Error(`No RPC URl configured for ${chainNameOrId}`);
    return publicRpcUrls[0].http;
  }

  /**
   * Get a block explorer URL for given chain
   * @throws if chain's metadata has not been set
   */
  getExplorerUrl(chainNameOrId: ChainName | number): string {
    const explorers = this.getChainMetadata(chainNameOrId).blockExplorers;
    if (!explorers?.length) return 'UNKNOWN_EXPLORER_URL';
    else return explorers[0].url;
  }

  /**
   * Get a block explorer API URL for given chain
   * @throws if chain's metadata has not been set
   */
  getExplorerApiUrl(chainNameOrId: ChainName | number): string {
    const explorers = this.getChainMetadata(chainNameOrId).blockExplorers;
    if (!explorers?.length) return 'UNKNOWN_EXPLORER_API_URL';
    else return (explorers[0].apiUrl || explorers[0].url) + '/api';
  }

  /**
   * Get a block explorer URL for given chain's tx
   * @throws if chain's metadata has not been set
   */
  getExplorerTxUrl(
    chainNameOrId: ChainName | number,
    response: providers.TransactionResponse,
  ): string {
    return `${this.getExplorerUrl(chainNameOrId)}/tx/${response.hash}`;
  }

  /**
   * Get a block explorer URL for given chain's address
   * @throws if chain's metadata has not been set
   */
  async getExplorerAddressUrl(
    chainNameOrId: ChainName | number,
    address?: string,
  ): Promise<string> {
    const base = `${this.getExplorerUrl(chainNameOrId)}/address`;
    if (address) return `${base}/${address}`;
    const signerAddress = await this.getSignerAddress(chainNameOrId);
    return `${base}/${signerAddress}`;
  }

  /**
   * Get a block explorer URL for given chain's address
   * @throws if chain's metadata has not been set
   */
  getTransactionOverrides(
    chainNameOrId: ChainName | number,
  ): Partial<providers.TransactionRequest> {
    return this.getChainMetadata(chainNameOrId)?.transactionOverrides ?? {};
  }

  /**
   * Wait for given tx to be confirmed
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async handleTx(
    chainNameOrId: ChainName | number,
    tx: ContractTransaction | Promise<ContractTransaction>,
  ): Promise<ContractReceipt> {
    const confirmations =
      this.getChainMetadata(chainNameOrId).blocks?.confirmations || 1;
    const response = await tx;
    this.logger(
      `Pending ${this.getExplorerTxUrl(
        chainNameOrId,
        response,
      )} (waiting ${confirmations} blocks for confirmation)`,
    );
    return response.wait(confirmations);
  }

  /**
   * Populate a transaction's fields using signer address and overrides
   * @throws if chain's metadata has not been set or tx fails
   */
  async prepareTx(
    chainNameOrId: ChainName | number,
    tx: PopulatedTransaction,
    from?: string,
  ): Promise<providers.TransactionRequest> {
    const txFrom = from ? from : await this.getSignerAddress(chainNameOrId);
    const overrides = this.getTransactionOverrides(chainNameOrId);
    return {
      ...tx,
      from: txFrom,
      ...overrides,
    };
  }

  /**
   * Estimate gas for given tx
   * @throws if chain's metadata has not been set or tx fails
   */
  async estimateGas(
    chainNameOrId: ChainName | number,
    tx: PopulatedTransaction,
    from?: string,
  ): Promise<BigNumber> {
    const txReq = await this.prepareTx(chainNameOrId, tx, from);
    const provider = this.getProvider(chainNameOrId);
    return provider.estimateGas(txReq);
  }

  /**
   * Send a transaction and wait for confirmation
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async sendTransaction(
    chainNameOrId: ChainName | number,
    tx: PopulatedTransaction,
  ): Promise<ContractReceipt> {
    const txReq = await this.prepareTx(chainNameOrId, tx);
    const signer = this.getSigner(chainNameOrId);
    const response = await signer.sendTransaction(txReq);
    this.logger(`Sent tx ${response.hash}`);
    return this.handleTx(chainNameOrId, response);
  }

  /**
   * Creates a MultiProvider using the given signer for all test networks
   */
  static createTestMultiProvider(
    params: { signer?: Signer; provider?: Provider } = {},
  ): MultiProvider {
    const { signer, provider } = params;
    const chainMetadata = pick(defaultChainMetadata, TestChains);
    const mp = new MultiProvider(chainMetadata);
    if (signer) {
      mp.setSharedSigner(signer);
    }
    const _provider = provider || signer?.provider;
    if (_provider) {
      const providerMap: ChainMap<Provider> = {};
      TestChains.forEach((t) => (providerMap[t] = _provider));
      mp.setProviders(providerMap);
    }
    return mp;
  }
}

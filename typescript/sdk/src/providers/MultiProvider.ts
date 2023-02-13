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

interface Params {
  chainMetadata?: ChainMap<ChainMetadata>;
  providers?: ChainMap<Provider>;
  signers?: ChainMap<Signer>;
}

export class MultiProvider {
  public readonly metadata: ChainMap<ChainMetadata>;
  private readonly providers: ChainMap<Provider>;
  private readonly signers: ChainMap<Signer>;
  private readonly logger: Debugger;

  constructor({ chainMetadata, providers, signers }: Params = {}) {
    this.metadata = chainMetadata ?? defaultChainMetadata;
    this.providers = providers ?? {};
    this.signers = signers ?? {};
    this.logger = debug('hyperlane:MultiProvider');
  }

  /**
   * Get the metadata for a given chain name or chain id
   * @throws if chain's metadata has not been set
   */
  tryGetChainMetadata(chainNameOrId: ChainName | number): ChainMetadata | null {
    let chainMetadata: ChainMetadata | undefined;
    if (typeof chainNameOrId === 'string') {
      chainMetadata = this.metadata[chainNameOrId];
    } else {
      chainMetadata = Object.values(this.metadata).find(
        (m) => m.chainId === chainNameOrId,
      );
    }
    return chainMetadata || null;
  }

  /**
   * Get the metadata for a given chain name or chain id
   * @throws if chain's metadata has not been set
   */
  getChainMetadata(chainNameOrId: ChainName | number): ChainMetadata {
    const chainMetadata = this.tryGetChainMetadata(chainNameOrId);
    if (!chainMetadata)
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    return chainMetadata;
  }

  /**
   * Get the name for a given chain name or chain id
   */
  tryGetChainName(chainNameOrId: ChainName | number): string | null {
    return this.tryGetChainMetadata(chainNameOrId)?.name ?? null;
  }

  /**
   * Get the name for a given chain name or chain id
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
   * Get the id for a given chain name or chain id
   */
  tryGetChainId(chainNameOrId: ChainName | number): number | null {
    return this.tryGetChainMetadata(chainNameOrId)?.chainId ?? null;
  }

  /**
   * Get the id for a given chain name or chain id
   * @throws if chain's metadata has not been set
   */
  getChainId(chainNameOrId: ChainName | number): number {
    return this.getChainMetadata(chainNameOrId).chainId;
  }

  /**
   * Get the ids for all chains known to this MultiProvider
   */
  getChainIds(): number[] {
    return Object.values(this.metadata).map((c) => c.chainId);
  }

  /**
   * Get the domain id for a given chain name or chain id
   */
  tryGetDomainId(chainNameOrId: ChainName | number): number | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    return metadata?.domainId ?? metadata?.chainId ?? null;
  }

  /**
   * Get the domain id for a given chain name or chain id
   * @throws if chain's metadata has not been set
   */
  getDomainId(chainNameOrId: ChainName | number): number {
    const metadata = this.getChainMetadata(chainNameOrId);
    return metadata.domainId ?? metadata.chainId;
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
      metadataList.find((c) => c.chainId === domainId);
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
   * Returns name for given domain id or name
   */
  resolveDomainOrName(domainIdOrName: ChainName | number): ChainName {
    if (typeof domainIdOrName === 'string') return domainIdOrName;
    else return this.domainIdToChainName(domainIdOrName);
  }

  /**
   * Get an Ethers provider for a given chain name or chain id
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
    } else if (publicRpcUrls.length) {
      this.providers[name] = new providers.JsonRpcProvider(
        publicRpcUrls[0].http,
        id,
      );
    }

    return this.providers[name] ?? null;
  }

  /**
   * Get an Ethers provider for a given chain name or chain id
   * @throws if chain's metadata has not been set
   */
  getProvider(chainNameOrId: ChainName | number): Provider {
    const provider = this.tryGetProvider(chainNameOrId);
    if (!provider)
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    return provider;
  }

  /**
   * Sets an Ethers provider for a given chain name or chain id
   * @throws if chain's metadata has not been set
   */
  setProvider(chainNameOrId: ChainName | number, provider: Provider): Provider {
    const chainName = this.getChainName(chainNameOrId);
    this.providers[chainName] = provider;
    return provider;
  }

  /**
   * Get an Ethers signer for a given chain name or chain id
   */
  tryGetSigner(chainNameOrId: ChainName | number): Signer | null {
    const chainName = this.tryGetChainName(chainNameOrId);
    if (chainName && this.signers[chainName]) return this.signers[chainName];
    return null;
  }

  /**
   * Get an Ethers signer for a given chain name or chain id
   * @throws if chain's metadata or signer has not been set
   */
  getSigner(chainNameOrId: ChainName | number): Signer {
    const chainName = this.getChainName(chainNameOrId);
    if (this.signers[chainName]) return this.signers[chainName];
    else throw new Error(`No chain signer set for ${chainNameOrId}`);
  }

  /**
   * Get an Ethers signer for a given chain name or chain id
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
   * Sets an Ethers Signer for a given chain name or chain id
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
      chainMetadata: intersectionMetadata,
      providers: intersectionProviders,
      signers: intersectionSigners,
    });
    return { intersection, multiProvider };
  }

  /**
   * Get chain names excluding given chain name
   */
  getRemoteChains(name: ChainName): ChainName[] {
    return this.getChainNames().filter((n) => n !== name);
  }

  /**
   * Get an RPC URL for given chain
   * @throws if chain's metadata or signer has not been set
   */
  getRpcUrl(chainNameOrId: ChainName | number): string {
    return this.getChainMetadata(chainNameOrId).publicRpcUrls[0].http;
  }

  /**
   * Get a block explorer URL for given chain
   * @throws if chain's metadata or signer has not been set
   */
  getExplorerUrl(chainNameOrId: ChainName | number): string {
    return this.getChainMetadata(chainNameOrId).blockExplorers[0].url;
  }

  /**
   * Get a block explorer API URL for given chain
   * @throws if chain's metadata or signer has not been set
   */
  getExplorerApiUrl(chainNameOrId: ChainName | number): string {
    const explorer = this.getChainMetadata(chainNameOrId).blockExplorers[0];
    return (explorer.apiUrl || explorer.url) + '/api';
  }

  /**
   * Get a block explorer URL for given chain's tx
   * @throws if chain's metadata or signer has not been set
   */
  getExplorerTxUrl(
    chainNameOrId: ChainName | number,
    response: providers.TransactionResponse,
  ): string {
    return `${this.getExplorerUrl(chainNameOrId)}/tx/${response.hash}`;
  }

  /**
   * Get a block explorer URL for given chain's address
   * @throws if chain's metadata or signer has not been set
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
  ): Partial<providers.TransactionRequest> | undefined {
    return this.getChainMetadata(chainNameOrId)?.transactionOverrides;
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
      this.getChainMetadata(chainNameOrId).blocks.confirmations;
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
   * Estimate gas for given tx
   * @throws if chain's metadata has not been set or tx fails
   */
  async estimateGas(
    chainNameOrId: ChainName | number,
    tx: PopulatedTransaction,
    from?: string,
  ): Promise<BigNumber> {
    let txFrom = from;
    if (!txFrom) {
      txFrom = await this.getSignerAddress(chainNameOrId);
    }
    const provider = this.getProvider(chainNameOrId);
    const overrides = this.getTransactionOverrides(chainNameOrId);
    return provider.estimateGas({
      ...tx,
      from: txFrom,
      ...overrides,
    });
  }

  /**
   * Send a transaction and wait for confirmation
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async sendTransaction(
    chainNameOrId: ChainName | number,
    tx: PopulatedTransaction,
  ): Promise<ContractReceipt> {
    const signer = this.getSigner(chainNameOrId);
    const from = await signer.getAddress();
    const overrides = this.getTransactionOverrides(chainNameOrId);
    const response = await signer.sendTransaction({
      ...tx,
      from,
      ...overrides,
    });
    this.logger(`Sent tx ${response.hash}`);
    return this.handleTx(chainNameOrId, response);
  }

  /**
   * Creates a MultiProvider using the given signer for all test networks
   */
  static createTestMultiProvider(signer: Signer): MultiProvider {
    const metadata = pick(defaultChainMetadata, TestChains);
    const signers: ChainMap<Signer> = {};
    TestChains.forEach((t) => (signers[t] = signer));
    return new MultiProvider({
      chainMetadata: metadata,
      signers,
    });
  }
}

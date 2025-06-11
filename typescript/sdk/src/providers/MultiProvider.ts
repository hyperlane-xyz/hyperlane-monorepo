import {
  BigNumber,
  Contract,
  ContractFactory,
  ContractReceipt,
  ContractTransaction,
  PopulatedTransaction,
  Signer,
  providers,
} from 'ethers';
import { Logger } from 'pino';
import {
  ContractFactory as ZKSyncContractFactory,
  Provider as ZKSyncProvider,
  Wallet as ZKSyncWallet,
} from 'zksync-ethers';

import { ZKSyncArtifact } from '@hyperlane-xyz/core';
import {
  Address,
  addBufferToGasLimit,
  pick,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { testChainMetadata, testChains } from '../consts/testChains.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import {
  ChainMetadata,
  ChainTechnicalStack,
} from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName, ChainNameOrId } from '../types.js';
import { ZKSyncDeployer } from '../zksync/ZKSyncDeployer.js';

import { AnnotatedEV5Transaction } from './ProviderType.js';
import {
  ProviderBuilderFn,
  defaultProviderBuilder,
  defaultZKProviderBuilder,
} from './providerBuilders.js';

type Provider = providers.Provider;

export interface MultiProviderOptions {
  logger?: Logger;
  providers?: ChainMap<Provider>;
  providerBuilder?: ProviderBuilderFn<Provider>;
  signers?: ChainMap<Signer>;
}

/**
 * A utility class to create and manage providers and signers for multiple chains
 * @typeParam MetaExt - Extra metadata fields for chains (such as contract addresses)
 */
export class MultiProvider<MetaExt = {}> extends ChainMetadataManager<MetaExt> {
  readonly providers: ChainMap<Provider>;
  readonly providerBuilder: ProviderBuilderFn<Provider>;
  signers: ChainMap<Signer>;
  useSharedSigner = false; // A single signer to be used for all chains
  readonly logger: Logger;

  /**
   * Create a new MultiProvider with the given chainMetadata,
   * or the SDK's default metadata if not provided
   */
  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    readonly options: MultiProviderOptions = {},
  ) {
    super(chainMetadata, options);
    this.logger =
      options?.logger ||
      rootLogger.child({
        module: 'MultiProvider',
      });
    this.providers = options?.providers || {};
    this.providerBuilder = options?.providerBuilder || defaultProviderBuilder;
    this.signers = options?.signers || {};
  }

  override addChain(metadata: ChainMetadata<MetaExt>): void {
    super.addChain(metadata);
    if (this.useSharedSigner) {
      const signers = Object.values(this.signers);
      if (signers.length > 0) {
        this.setSharedSigner(signers[0]);
      }
    }
  }

  override extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): MultiProvider<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new MultiProvider(newMetadata, this.options);
  }

  /**
   * Get an Ethers provider for a given chain name or domain id
   */
  tryGetProvider(chainNameOrId: ChainNameOrId): Provider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { name, chainId, rpcUrls, technicalStack } = metadata;

    if (this.providers[name]) return this.providers[name];

    if (testChains.includes(name)) {
      if (technicalStack === ChainTechnicalStack.ZkSync) {
        this.providers[name] = new ZKSyncProvider('http://127.0.0.1:8011', 260);
      } else {
        this.providers[name] = new providers.JsonRpcProvider(
          'http://127.0.0.1:8545',
          31337,
        );
      }
    } else if (rpcUrls.length) {
      if (technicalStack === ChainTechnicalStack.ZkSync) {
        this.providers[name] = defaultZKProviderBuilder(rpcUrls, chainId);
      } else {
        this.providers[name] = this.providerBuilder(rpcUrls, chainId);
      }
    } else {
      return null;
    }

    return this.providers[name];
  }

  /**
   * Get an Ethers provider for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getProvider(chainNameOrId: ChainNameOrId): Provider {
    const provider = this.tryGetProvider(chainNameOrId);
    if (!provider)
      throw new Error(`No chain metadata set for ${chainNameOrId}`);
    return provider;
  }

  /**
   * Sets an Ethers provider for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  setProvider(chainNameOrId: ChainNameOrId, provider: Provider): Provider {
    const chainName = this.getChainName(chainNameOrId);
    this.providers[chainName] = provider;
    const signer = this.signers[chainName];
    if (signer && signer.provider) {
      this.setSigner(chainName, signer.connect(provider));
    }
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
   * Get an Ethers signer for a given chain name or domain id
   * If signer is not yet connected, it will be connected
   */
  tryGetSigner(chainNameOrId: ChainNameOrId): Signer | null {
    const chainName = this.tryGetChainName(chainNameOrId);
    if (!chainName) return null;
    const signer = this.signers[chainName];
    if (!signer) return null;
    if (signer.provider) return signer;
    // Auto-connect the signer for convenience
    const provider = this.tryGetProvider(chainName);
    if (!provider) return signer;
    return signer.connect(provider);
  }

  /**
   * Get an Ethers signer for a given chain name or domain id
   * If signer is not yet connected, it will be connected
   * @throws if chain's metadata or signer has not been set
   */
  getSigner(chainNameOrId: ChainNameOrId): Signer {
    const signer = this.tryGetSigner(chainNameOrId);
    if (!signer) throw new Error(`No chain signer set for ${chainNameOrId}`);
    return signer;
  }

  /**
   * Get an Ethers signer for a given chain name or domain id
   * @throws if chain's metadata or signer has not been set
   */
  async getSignerAddress(chainNameOrId: ChainNameOrId): Promise<Address> {
    const signer = this.getSigner(chainNameOrId);
    const address = await signer.getAddress();
    return address;
  }

  /**
   * Sets an Ethers Signer for a given chain name or domain id
   * @throws if chain's metadata has not been set or shared signer has already been set
   */
  setSigner(chainNameOrId: ChainNameOrId, signer: Signer): Signer {
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
    chainNameOrId: ChainNameOrId,
  ): Signer | Provider | null {
    return (
      this.tryGetSigner(chainNameOrId) || this.tryGetProvider(chainNameOrId)
    );
  }

  /**
   * Gets the Signer if it's been set, otherwise the provider
   * @throws if chain metadata has not been set
   */
  getSignerOrProvider(chainNameOrId: ChainNameOrId): Signer | Provider {
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
  override intersect(
    chains: ChainName[],
    throwIfNotSubset = false,
  ): {
    intersection: ChainName[];
    result: MultiProvider<MetaExt>;
  } {
    const { intersection, result } = super.intersect(chains, throwIfNotSubset);
    const multiProvider = new MultiProvider(result.metadata, {
      ...this.options,
      providers: pick(this.providers, intersection),
      signers: pick(this.signers, intersection),
    });
    return { intersection, result: multiProvider };
  }

  /**
   * Get a block explorer URL for given chain's address
   */
  override async tryGetExplorerAddressUrl(
    chainNameOrId: ChainNameOrId,
    address?: string,
  ): Promise<string | null> {
    if (address) return super.tryGetExplorerAddressUrl(chainNameOrId, address);
    const signer = this.tryGetSigner(chainNameOrId);
    if (signer) {
      const signerAddr = await signer.getAddress();
      return super.tryGetExplorerAddressUrl(chainNameOrId, signerAddr);
    }
    return null;
  }

  /**
   * Get the latest block range for a given chain's RPC provider
   */
  async getLatestBlockRange(
    chainNameOrId: ChainNameOrId,
    rangeSize = this.getMaxBlockRange(chainNameOrId),
  ): Promise<{ fromBlock: number; toBlock: number }> {
    const toBlock = await this.getProvider(chainNameOrId).getBlock('latest');
    const fromBlock = Math.max(toBlock.number - rangeSize, 0);
    return { fromBlock, toBlock: toBlock.number };
  }

  /**
   * Get the transaction overrides for a given chain name or domain id
   * @throws if chain's metadata has not been set
   */
  getTransactionOverrides(
    chainNameOrId: ChainNameOrId,
  ): Partial<providers.TransactionRequest> {
    return this.getChainMetadata(chainNameOrId)?.transactionOverrides ?? {};
  }

  /**
   * Wait for deploy tx to be confirmed
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async handleDeploy<F extends ZKSyncContractFactory | ContractFactory>(
    chainNameOrId: ChainNameOrId,
    factory: F,
    params: Parameters<F['deploy']>,
    artifact?: ZKSyncArtifact,
  ): Promise<Awaited<ReturnType<F['deploy']>>> {
    const overrides = this.getTransactionOverrides(chainNameOrId);
    const signer = this.getSigner(chainNameOrId);
    const metadata = this.getChainMetadata(chainNameOrId);
    const { technicalStack } = metadata;

    let contract: Contract;
    let estimatedGas: BigNumber;

    // estimate gas for deploy
    // deploy with buffer on gas limit
    if (technicalStack === ChainTechnicalStack.ZkSync) {
      if (!artifact) throw new Error(`No ZkSync contract artifact provided!`);

      const deployer = new ZKSyncDeployer(signer as ZKSyncWallet);
      estimatedGas = await deployer.estimateDeployGas(artifact, params);
      contract = await deployer.deploy(artifact, params, {
        gasLimit: addBufferToGasLimit(estimatedGas),
        ...overrides,
      });
    } else {
      const contractFactory = factory.connect(signer);
      const deployTx = contractFactory.getDeployTransaction(...params);
      estimatedGas = await signer.estimateGas(deployTx);
      contract = await contractFactory.deploy(...params, {
        gasLimit: addBufferToGasLimit(estimatedGas),
        ...overrides,
      });
    }

    // wait for deploy tx to be confirmed
    await this.handleTx(chainNameOrId, contract.deployTransaction);

    this.logger.trace(
      `Contract deployed at ${contract.address} on ${chainNameOrId}:`,
      { transaction: contract.deployTransaction },
    );

    // return deployed contract
    return contract as Awaited<ReturnType<F['deploy']>>;
  }

  /**
   * Wait for given tx to be confirmed
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async handleTx(
    chainNameOrId: ChainNameOrId,
    tx: ContractTransaction | Promise<ContractTransaction>,
  ): Promise<ContractReceipt> {
    const confirmations =
      this.getChainMetadata(chainNameOrId).blocks?.confirmations ?? 1;
    const response = await tx;
    const txUrl = this.tryGetExplorerTxUrl(chainNameOrId, response);
    this.logger.info(
      `Pending ${
        txUrl || response.hash
      } (waiting ${confirmations} blocks for confirmation)`,
    );
    return response.wait(confirmations);
  }

  /**
   * Populate a transaction's fields using signer address and overrides
   * @throws if chain's metadata has not been set or tx fails
   */
  async prepareTx(
    chainNameOrId: ChainNameOrId,
    tx: PopulatedTransaction,
    from?: string,
  ): Promise<providers.TransactionRequest> {
    const txFrom = from ?? (await this.getSignerAddress(chainNameOrId));
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
    chainNameOrId: ChainNameOrId,
    tx: PopulatedTransaction,
    from?: string,
  ): Promise<BigNumber> {
    const txReq = {
      ...(await this.prepareTx(chainNameOrId, tx, from)),
      // Reset any tx request params that may have an unintended effect on gas estimation
      gasLimit: undefined,
      gasPrice: undefined,
      maxPriorityFeePerGas: undefined,
      maxFeePerGas: undefined,
    };
    const provider = this.getProvider(chainNameOrId);
    return provider.estimateGas(txReq);
  }

  /**
   * Send a transaction and wait for confirmation
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async sendTransaction(
    chainNameOrId: ChainNameOrId,
    txProm: AnnotatedEV5Transaction | Promise<AnnotatedEV5Transaction>,
  ): Promise<ContractReceipt> {
    const { annotation, ...tx } = await txProm;
    if (annotation) {
      this.logger.info(annotation);
    }
    const txReq = await this.prepareTx(chainNameOrId, tx);
    const signer = this.getSigner(chainNameOrId);
    const response = await signer.sendTransaction(txReq);
    this.logger.info(`Sent tx ${response.hash}`);
    return this.handleTx(chainNameOrId, response);
  }

  /**
   * Creates a MultiProvider using the given signer for all test networks
   */
  static createTestMultiProvider(
    params: {
      signer?: Signer;
      provider?: Provider;
    } = {},
    chains: ChainName[] = testChains,
  ): MultiProvider {
    const { signer, provider } = params;
    const mp = new MultiProvider(testChainMetadata);
    if (signer) {
      mp.setSharedSigner(signer);
    }
    const _provider = provider || signer?.provider;
    if (_provider) {
      const providerMap: ChainMap<Provider> = {};
      chains.forEach((t) => (providerMap[t] = _provider));
      mp.setProviders(providerMap);
    }
    return mp;
  }
}

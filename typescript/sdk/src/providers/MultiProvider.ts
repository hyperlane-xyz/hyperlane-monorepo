import { Logger } from 'pino';

import { ZKSyncArtifact } from '@hyperlane-xyz/core';
import {
  Address,
  addBufferToGasLimit,
  pick,
  rootLogger,
  timeout,
} from '@hyperlane-xyz/utils';

import { testChainMetadata, testChains } from '../consts/testChains.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import {
  ChainMetadata,
  ChainTechnicalStack,
  EthJsonRpcBlockParameterTag,
} from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName, ChainNameOrId } from '../types.js';
import { ZKSyncDeployer } from '../zksync/ZKSyncDeployer.js';

import { AnnotatedEV5Transaction } from './ProviderType.js';
import {
  ProviderBuilderFn,
  defaultProviderBuilder,
  defaultZKProviderBuilder,
} from './providerBuilders.js';

type Provider = ReturnType<typeof defaultProviderBuilder>;
type EvmSigner = {
  provider?: Provider;
  connect(provider: Provider): EvmSigner;
  estimateGas(tx: unknown): Promise<unknown>;
  getAddress(): Promise<string>;
  sendTransaction(tx: unknown): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<unknown>;
  }>;
};
type ContractTransaction = Awaited<ReturnType<EvmSigner['sendTransaction']>>;
type ContractReceipt = Awaited<ReturnType<ContractTransaction['wait']>>;
type PopulatedTransaction = Record<string, unknown>;
type TransactionOverrides = Record<string, unknown>;
type GasAmount = Awaited<ReturnType<Provider['estimateGas']>>;
type DeployableContract = {
  address: string;
  deployTransaction: ContractTransaction;
} & Record<string, unknown>;
type DeployableFactory = {
  connect(signer: EvmSigner): {
    getDeployTransaction(...params: unknown[]): unknown;
    deploy(...params: unknown[]): Promise<DeployableContract>;
  };
  deploy(...params: unknown[]): Promise<DeployableContract>;
};

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 300_000;
const MIN_CONFIRMATION_TIMEOUT_MS = 30_000;

export interface MultiProviderOptions {
  logger?: Logger;
  providers?: ChainMap<Provider>;
  providerBuilder?: ProviderBuilderFn<Provider>;
  signers?: ChainMap<EvmSigner>;
}

export interface SendTransactionOptions {
  /**
   * Number of confirmations to wait for, or a block tag like "finalized" or "safe".
   * If not provided, uses chain metadata's blocks.confirmations (default: 1).
   */
  waitConfirmations?: number | EthJsonRpcBlockParameterTag;
  /**
   * Timeout in ms when waiting for confirmations.
   * Default: max(2 × confirmations × estimateBlockTime, 30s) when available, otherwise 300000 (5 min).
   */
  timeoutMs?: number;
}

/**
 * A utility class to create and manage providers and signers for multiple chains
 * @typeParam MetaExt - Extra metadata fields for chains (such as contract addresses)
 */
export class MultiProvider<MetaExt = {}> extends ChainMetadataManager<MetaExt> {
  readonly providers: ChainMap<Provider>;
  readonly providerBuilder: ProviderBuilderFn<Provider>;
  signers: ChainMap<EvmSigner>;
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
      const rpcUrls = [
        {
          http:
            technicalStack === ChainTechnicalStack.ZkSync
              ? 'http://127.0.0.1:8011'
              : 'http://127.0.0.1:8545',
        },
      ];
      const chainId =
        technicalStack === ChainTechnicalStack.ZkSync ? 260 : 31337;
      if (technicalStack === ChainTechnicalStack.ZkSync) {
        this.providers[name] = defaultZKProviderBuilder(rpcUrls, chainId);
      } else {
        this.providers[name] = this.providerBuilder(rpcUrls, chainId);
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
  tryGetSigner(chainNameOrId: ChainNameOrId): EvmSigner | null {
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
  getSigner(chainNameOrId: ChainNameOrId): EvmSigner {
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
  setSigner(chainNameOrId: ChainNameOrId, signer: EvmSigner): EvmSigner {
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
  setSigners(signers: ChainMap<EvmSigner>): void {
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
  ): EvmSigner | Provider | null {
    return (
      this.tryGetSigner(chainNameOrId) || this.tryGetProvider(chainNameOrId)
    );
  }

  /**
   * Gets the Signer if it's been set, otherwise the provider
   * @throws if chain metadata has not been set
   */
  getSignerOrProvider(chainNameOrId: ChainNameOrId): EvmSigner | Provider {
    return this.tryGetSigner(chainNameOrId) || this.getProvider(chainNameOrId);
  }

  /**
   * Sets Ethers Signers to be used for all chains
   * Any subsequent calls to getSigner will return given signer
   * Setting sharedSigner to null clears all signers
   */
  setSharedSigner(sharedSigner: EvmSigner | null): EvmSigner | null {
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
  getTransactionOverrides(chainNameOrId: ChainNameOrId): TransactionOverrides {
    return (
      (this.getChainMetadata(chainNameOrId)?.transactionOverrides as
        | TransactionOverrides
        | undefined) ?? {}
    );
  }

  /**
   * Wait for deploy tx to be confirmed
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async handleDeploy<F extends DeployableFactory>(
    chainNameOrId: ChainNameOrId,
    factory: F,
    params: Parameters<F['deploy']>,
    artifact?: ZKSyncArtifact,
  ): Promise<Awaited<ReturnType<F['deploy']>>> {
    const overrides = this.getTransactionOverrides(chainNameOrId);
    const signer = this.getSigner(chainNameOrId);
    const metadata = this.getChainMetadata(chainNameOrId);
    const { technicalStack } = metadata;

    let contract: DeployableContract;
    let estimatedGas: GasAmount;

    // estimate gas for deploy
    // deploy with buffer on gas limit
    if (technicalStack === ChainTechnicalStack.ZkSync) {
      if (!artifact) throw new Error(`No ZkSync contract artifact provided!`);

      const deployer = new ZKSyncDeployer(signer);
      estimatedGas = await deployer.estimateDeployGas(artifact, params);
      contract = (await deployer.deploy(artifact, params, {
        gasLimit: addBufferToGasLimit(estimatedGas),
        ...overrides,
      })) as DeployableContract;
      // no need to `handleTx` for zkSync as the zksync deployer itself
      // will wait for the deploy tx to be confirmed before returning
    } else {
      const contractFactory = factory.connect(signer);
      const deployTx = contractFactory.getDeployTransaction(...params);
      estimatedGas = await signer.estimateGas(deployTx);
      contract = await contractFactory.deploy(...params, {
        gasLimit: addBufferToGasLimit(estimatedGas),
        ...overrides,
      });
      // manually wait for deploy tx to be confirmed for non-zksync chains
      await this.handleTx(chainNameOrId, contract.deployTransaction);
    }

    this.logger.trace(
      `Contract deployed at ${contract.address} on ${chainNameOrId}:`,
      { transaction: contract.deployTransaction },
    );

    // return deployed contract
    return contract as Awaited<ReturnType<F['deploy']>>;
  }

  /**
   * Wait for given tx to be confirmed
   * @param options - Optional configuration including waitConfirmations and timeoutMs
   * @throws if chain's metadata or signer has not been set, tx fails, block tag unsupported, or timeout exceeded
   */
  async handleTx(
    chainNameOrId: ChainNameOrId,
    tx: ContractTransaction | Promise<ContractTransaction>,
    options?: SendTransactionOptions,
  ): Promise<ContractReceipt> {
    const response = await tx;
    const txUrl = this.tryGetExplorerTxUrl(chainNameOrId, response);

    const metadata = this.getChainMetadata(chainNameOrId);
    // Use provided waitConfirmations, or fall back to chain metadata confirmations
    const confirmations =
      options?.waitConfirmations ?? metadata.blocks?.confirmations ?? 1;

    const estimateBlockTime = metadata.blocks?.estimateBlockTime;
    const dynamicTimeout =
      typeof confirmations === 'number' && estimateBlockTime
        ? Math.max(
            confirmations * estimateBlockTime * 1000 * 2,
            MIN_CONFIRMATION_TIMEOUT_MS,
          )
        : DEFAULT_CONFIRMATION_TIMEOUT_MS;
    const timeoutMs = options?.timeoutMs ?? dynamicTimeout;

    // Handle string block tags (e.g., "finalized", "safe")
    if (typeof confirmations === 'string') {
      this.logger.info(
        `Pending ${txUrl || response.hash} (waiting for ${confirmations} block)`,
      );
      return this.waitForBlockTag(
        chainNameOrId,
        response,
        confirmations,
        timeoutMs,
      );
    }

    // Handle numeric confirmations
    this.logger.info(
      `Pending ${txUrl || response.hash} (waiting ${confirmations} blocks for confirmation)`,
    );
    const receipt = await timeout(
      response.wait(confirmations),
      timeoutMs,
      `Timeout (${timeoutMs}ms) waiting for ${confirmations} block confirmations for tx ${response.hash}`,
    );

    // ethers v5 can return null for wait(0) if tx is still pending.
    if (receipt) return receipt;

    this.logger.info(
      `Pending ${txUrl || response.hash} (wait(0) returned pending, waiting for initial inclusion)`,
    );
    return timeout(
      response.wait(1),
      timeoutMs,
      `Timeout (${timeoutMs}ms) waiting for initial inclusion for tx ${response.hash}`,
    );
  }

  /**
   * Wait for a transaction to be included in a block with the given tag (e.g., "finalized", "safe").
   * Polls until the tagged block number >= transaction block number.
   * @param timeoutMs - Timeout in ms (default: 300000 = 5 min)
   * @throws if block tag is unsupported by the RPC provider or timeout exceeded
   * @internal - Prefer using handleTx with waitConfirmations parameter.
   */
  async waitForBlockTag(
    chainNameOrId: ChainNameOrId,
    response: ContractTransaction,
    blockTag: EthJsonRpcBlockParameterTag,
    timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  ): Promise<ContractReceipt> {
    const provider = this.getProvider(chainNameOrId);
    const receipt = await response.wait(1); // Wait for initial inclusion
    const txBlock = receipt.blockNumber;

    // Check if block tag is supported on first call
    const initialTaggedBlock = await provider.getBlock(blockTag);
    if (initialTaggedBlock === null) {
      throw new Error(
        `Block tag "${blockTag}" not supported by RPC provider for chain ${chainNameOrId}`,
      );
    }

    // Check if already confirmed
    if (initialTaggedBlock.number >= txBlock) {
      this.logger.info(
        `Transaction ${response.hash} confirmed at ${blockTag} block ${initialTaggedBlock.number}`,
      );
      // Re-fetch receipt to get canonical block info after potential reorgs
      const finalReceipt = await provider.getTransactionReceipt(response.hash);
      if (!finalReceipt) {
        throw new Error(
          `Transaction ${response.hash} not found after ${blockTag} confirmation - may have been reorged out`,
        );
      }
      return finalReceipt;
    }

    const POLL_INTERVAL_MS = 2000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const taggedBlock = await provider.getBlock(blockTag);
      if (taggedBlock && taggedBlock.number >= txBlock) {
        this.logger.info(
          `Transaction ${response.hash} confirmed at ${blockTag} block ${taggedBlock.number}`,
        );
        // Re-fetch receipt to get canonical block info after potential reorgs
        const finalReceipt = await provider.getTransactionReceipt(
          response.hash,
        );
        if (!finalReceipt) {
          throw new Error(
            `Transaction ${response.hash} not found after ${blockTag} confirmation - may have been reorged out`,
          );
        }
        return finalReceipt;
      }
    }

    throw new Error(
      `Timeout (${timeoutMs}ms) waiting for ${blockTag} block for tx ${response.hash}`,
    );
  }

  /**
   * Populate a transaction's fields using signer address and overrides
   * @throws if chain's metadata has not been set or tx fails
   */
  async prepareTx(
    chainNameOrId: ChainNameOrId,
    tx: PopulatedTransaction,
    from?: string,
  ): Promise<Record<string, unknown>> {
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
  ): Promise<GasAmount> {
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
   * @param options - Optional configuration including waitConfirmations
   * @throws if chain's metadata or signer has not been set or tx fails
   */
  async sendTransaction(
    chainNameOrId: ChainNameOrId,
    txProm: AnnotatedEV5Transaction | Promise<AnnotatedEV5Transaction>,
    options?: SendTransactionOptions,
  ): Promise<ContractReceipt> {
    const { annotation, ...tx } = await txProm;
    if (annotation) {
      this.logger.info(annotation);
    }
    const txReq = await this.prepareTx(chainNameOrId, tx);
    const signer = this.getSigner(chainNameOrId);
    const response = await signer.sendTransaction(txReq);
    this.logger.info(`Sent tx ${response.hash}`);
    return this.handleTx(chainNameOrId, response, options);
  }

  /**
   * Creates a MultiProvider using the given signer for all test networks
   */
  static createTestMultiProvider(
    params: {
      signer?: EvmSigner;
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

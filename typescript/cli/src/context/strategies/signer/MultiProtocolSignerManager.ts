import { Signer } from 'ethers';
import { Logger } from 'pino';
import { Account as StarknetAccount } from 'starknet';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ENV } from '../../../utils/env.js';

import {
  IMultiProtocolSigner,
  SignerConfig,
  TypedSigner,
} from './BaseMultiProtocolSigner.js';
import { MultiProtocolSignerFactory } from './MultiProtocolSignerFactory.js';

export interface MultiProtocolSignerOptions {
  logger?: Logger;
  key?: string;
}

/**
 * @title MultiProtocolSignerManager
 * @dev Context manager for signers across multiple protocols
 */
export class MultiProtocolSignerManager {
  protected readonly signerStrategies: Map<ChainName, IMultiProtocolSigner>;
  protected readonly signers: Map<ChainName, TypedSigner>;
  public readonly logger: Logger;

  constructor(
    protected readonly submissionStrategy: ChainSubmissionStrategy,
    protected readonly chains: ChainName[],
    protected readonly multiProvider: MultiProvider,
    protected readonly multiProtocolProvider: MultiProtocolProvider,
    protected readonly options: MultiProtocolSignerOptions = {},
  ) {
    this.logger =
      options?.logger ||
      rootLogger.child({
        module: 'MultiProtocolSignerManager',
      });
    this.signerStrategies = new Map();
    this.signers = new Map();
    this.initializeStrategies();
  }

  protected get compatibleChains(): ChainName[] {
    return this.chains.filter(
      (chain) =>
        this.multiProvider.getProtocol(chain) === ProtocolType.Ethereum ||
        this.multiProvider.getProtocol(chain) === ProtocolType.CosmosNative ||
        this.multiProvider.getProtocol(chain) === ProtocolType.Starknet,
    );
  }

  /**
   * @notice Sets up chain-specific signer strategies
   */
  protected initializeStrategies(): void {
    for (const chain of this.compatibleChains) {
      const strategy = MultiProtocolSignerFactory.getSignerStrategy(
        chain,
        this.submissionStrategy,
        this.multiProvider,
      );
      this.signerStrategies.set(chain, strategy);
    }
  }

  /**
   * @dev Configures signers for EVM chains in MultiProvider
   */
  async getMultiProvider(): Promise<MultiProvider> {
    for (const chain of this.compatibleChains) {
      const signer = await this.initSigner(chain);
      if (this.multiProvider.getProtocol(chain) === ProtocolType.Ethereum) {
        this.multiProvider.setSigner(chain, signer as Signer);
      }
    }

    return this.multiProvider;
  }

  protected getSpecificSigner<T>(chain: ChainName): T {
    return this.signers.get(chain) as T;
  }

  getEVMSigner(chain: ChainName): Signer {
    const protocol = this.multiProvider.getChainMetadata(chain).protocol;
    if (protocol !== ProtocolType.Ethereum) {
      throw new Error(`Chain ${chain} is not an Ethereum chain`);
    }
    return this.getSpecificSigner<Signer>(chain);
  }

  getStarknetSigner(chain: ChainName): StarknetAccount {
    const protocol = this.multiProvider.getChainMetadata(chain).protocol;
    if (protocol !== ProtocolType.Starknet) {
      throw new Error(`Chain ${chain} is not a Starknet chain`);
    }
    return this.getSpecificSigner<StarknetAccount>(chain);
  }

  /**
   * @notice Creates signer for specific chain
   */
  async initSigner(chain: ChainName): Promise<TypedSigner> {
    const config = await this.resolveConfig(chain);
    const signerStrategy = this.getSignerStrategyOrFail(chain);
    const signer = await signerStrategy.getSigner(config);

    this.signers.set(chain, signer);
    return signer;
  }

  /**
   * @notice Creates signers for all chains
   */
  async initAllSigners(): Promise<typeof this.signers> {
    const signerConfigs = await this.resolveAllConfigs();

    for (const { chain, privateKey, userAddress } of signerConfigs) {
      const signerStrategy = this.signerStrategies.get(chain);
      if (signerStrategy) {
        const { protocol } = this.multiProvider.getChainMetadata(chain);
        if (protocol === ProtocolType.Starknet) {
          const provider =
            this.multiProtocolProvider?.getStarknetProvider(chain);
          this.signers.set(
            chain,
            await signerStrategy.getSigner({
              privateKey,
              userAddress,
              extraParams: { provider },
            }),
          );
        } else {
          // evm chains
          this.signers.set(
            chain,
            await signerStrategy.getSigner({ privateKey }),
          );
        }
      }
    }

    return this.signers;
  }

  /**
   * @notice Resolves all chain configurations sequentially to avoid event listener leaks
   */
  private async resolveAllConfigs(): Promise<
    Array<{ chain: ChainName } & SignerConfig>
  > {
    const configs: Array<{ chain: ChainName } & SignerConfig> = [];
    for (const chain of this.chains) {
      const config = await this.resolveConfig(chain);
      configs.push(config);
    }
    return configs;
  }

  /**
   * @notice Resolves single chain configuration
   */
  private async resolveConfig(
    chain: ChainName,
  ): Promise<{ chain: ChainName } & SignerConfig> {
    const { protocol } = this.multiProvider.getChainMetadata(chain);

    // For Cosmos, we must use strategy config
    if (protocol === ProtocolType.CosmosNative) {
      return this.resolveCosmosNativeConfig(chain, this.options.key);
    }

    // For Starknet, we must use strategy config
    if (protocol === ProtocolType.Starknet) {
      return this.resolveStarknetConfig(chain);
    }

    // For other protocols, try CLI/ENV keys first, then fallback to strategy
    const config = await this.extractPrivateKey(chain);
    return { chain, ...config };
  }

  /**
   * @notice Gets private key from strategy
   */
  private async extractPrivateKey(chain: ChainName): Promise<SignerConfig> {
    if (this.options.key) {
      this.logger.info(
        `Using private key passed via CLI --key flag for chain ${chain}`,
      );
      return { privateKey: this.options.key };
    }

    if (ENV.HYP_KEY) {
      this.logger.info(`Using private key from .env for chain ${chain}`);
      return { privateKey: ENV.HYP_KEY };
    }

    const signerStrategy = this.getSignerStrategyOrFail(chain);
    const strategyConfig = await signerStrategy.getSignerConfig(chain);
    assert(
      strategyConfig.privateKey,
      `No private key found for chain ${chain}`,
    );
    this.logger.info(
      `Extracting private key from strategy config/user prompt for chain ${chain}`,
    );
    return { privateKey: strategyConfig.privateKey };
  }

  private async resolveCosmosNativeConfig(
    chain: ChainName,
    key?: string,
  ): Promise<{ chain: ChainName } & SignerConfig> {
    const signerStrategy = this.getSignerStrategyOrFail(chain);

    if (!key) {
      const strategyConfig = await signerStrategy.getSignerConfig(chain);
      key = strategyConfig.privateKey;
    }

    const provider =
      await this.multiProtocolProvider.getCosmJsNativeProvider(chain);
    const { bech32Prefix, gasPrice } =
      this.multiProvider.getChainMetadata(chain);

    assert(key, `No private key found for chain ${chain}`);
    assert(provider, 'No Cosmos Native Provider found');

    this.logger.info(`Using strategy config for Cosmos Native chain ${chain}`);

    return {
      chain,
      privateKey: key,
      extraParams: { provider, prefix: bech32Prefix, gasPrice },
    };
  }

  getCosmosNativeSigner(chain: ChainName): SigningHyperlaneModuleClient {
    const protocolType = this.multiProvider.getProtocol(chain);
    assert(
      protocolType === ProtocolType.CosmosNative,
      `Chain ${chain} is not a Cosmos Native chain`,
    );
    return this.getSpecificSigner<SigningHyperlaneModuleClient>(chain);
  }

  private async resolveStarknetConfig(
    chain: ChainName,
  ): Promise<{ chain: ChainName } & SignerConfig> {
    const signerStrategy = this.getSignerStrategyOrFail(chain);
    const strategyConfig = await signerStrategy.getSignerConfig(chain);
    const provider = this.multiProtocolProvider.getStarknetProvider(chain);

    assert(
      strategyConfig.privateKey,
      `No private key found for chain ${chain}`,
    );
    assert(strategyConfig.userAddress, 'No Starknet Address found');
    assert(provider, 'No Starknet Provider found');

    this.logger.info(`Using strategy config for Starknet chain ${chain}`);

    return {
      chain,
      privateKey: strategyConfig.privateKey,
      userAddress: strategyConfig.userAddress,
      extraParams: { provider },
    };
  }

  private getSignerStrategyOrFail(chain: ChainName): IMultiProtocolSigner {
    const strategy = this.signerStrategies.get(chain);
    assert(strategy, `No signer strategy found for chain ${chain}`);
    return strategy;
  }
}

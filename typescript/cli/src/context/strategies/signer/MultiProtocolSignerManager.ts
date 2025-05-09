import { Signer } from 'ethers';
import { Logger } from 'pino';
import { Account as StarknetAccount } from 'starknet';

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
    private multiProtocolProvider: MultiProtocolProvider,
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

  /**
   * @notice Sets up chain-specific signer strategies
   */
  protected initializeStrategies(): void {
    for (const chain of this.chains) {
      if (
        this.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum &&
        this.multiProvider.getProtocol(chain) !== ProtocolType.Starknet
      ) {
        this.logger.debug(
          `Skipping signer strategy initialization for non-EVM chain ${chain}`,
        );
        continue;
      }
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
    const ethereumChains = this.chains.filter(
      (chain) =>
        this.multiProvider.getChainMetadata(chain).protocol ===
        ProtocolType.Ethereum,
    );

    for (const chain of ethereumChains) {
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
    return signerStrategy.getSigner(config);
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
            signerStrategy.getSigner({
              privateKey,
              userAddress,
              extraParams: { provider },
            }),
          );
        } else {
          // evm chains
          this.signers.set(chain, signerStrategy.getSigner({ privateKey }));
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

    // For Starknet, we must use strategy config
    if (protocol === ProtocolType.Starknet) {
      return this.resolveStarknetConfig(chain);
    }

    const signerStrategy = this.signerStrategies.get(chain);
    assert(signerStrategy, `No signer strategy found for chain ${chain}`);

    let privateKey: string;

    if (this.options.key) {
      this.logger.debug(
        `Using private key passed via CLI --key flag for chain ${chain}`,
      );
      privateKey = this.options.key;
    } else if (ENV.HYP_KEY) {
      this.logger.debug(`Using private key from .env for chain ${chain}`);
      privateKey = ENV.HYP_KEY;
    } else {
      privateKey = await this.extractPrivateKey(chain, signerStrategy);
    }

    return { chain, privateKey };
  }

  /**
   * @notice Gets private key from strategy
   */
  private async extractPrivateKey(
    chain: ChainName,
    signerStrategy: IMultiProtocolSigner,
  ): Promise<string> {
    const strategyConfig = await signerStrategy.getSignerConfig(chain);
    assert(
      strategyConfig.privateKey,
      `No private key found for chain ${chain}`,
    );

    this.logger.debug(
      `Extracting private key from strategy config/user prompt for chain ${chain}`,
    );
    return strategyConfig.privateKey;
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

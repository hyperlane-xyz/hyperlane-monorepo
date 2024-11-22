import { Signer } from 'ethers';
import { Logger } from 'pino';

import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { ENV } from '../../../utils/env.js';

import { IMultiProtocolSigner } from './BaseMultiProtocolSigner.js';
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
  protected readonly signers: Map<ChainName, Signer>;
  public readonly logger: Logger;

  constructor(
    protected readonly submissionStrategy: ChainSubmissionStrategy,
    protected readonly chains: ChainName[],
    protected readonly multiProvider: MultiProvider,
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
    for (const chain of this.chains) {
      const signer = await this.initSigner(chain);
      this.multiProvider.setSigner(chain, signer);
    }

    return this.multiProvider;
  }

  /**
   * @notice Creates signer for specific chain
   */
  async initSigner(chain: ChainName): Promise<Signer> {
    const { privateKey } = await this.resolveConfig(chain);

    const signerStrategy = this.signerStrategies.get(chain);
    assert(signerStrategy, `No signer strategy found for chain ${chain}`);

    return signerStrategy.getSigner({ privateKey });
  }

  /**
   * @notice Creates signers for all chains
   */
  async initAllSigners(): Promise<typeof this.signers> {
    const signerConfigs = await this.resolveAllConfigs();

    for (const { chain, privateKey } of signerConfigs) {
      const signerStrategy = this.signerStrategies.get(chain);
      if (signerStrategy) {
        this.signers.set(chain, signerStrategy.getSigner({ privateKey }));
      }
    }

    return this.signers;
  }

  /**
   * @notice Resolves all chain configurations
   */
  private async resolveAllConfigs(): Promise<
    Array<{ chain: ChainName; privateKey: string }>
  > {
    return Promise.all(this.chains.map((chain) => this.resolveConfig(chain)));
  }

  /**
   * @notice Resolves single chain configuration
   */
  private async resolveConfig(
    chain: ChainName,
  ): Promise<{ chain: ChainName; privateKey: string }> {
    const signerStrategy = this.signerStrategies.get(chain);
    assert(signerStrategy, `No signer strategy found for chain ${chain}`);

    let privateKey: string;

    if (this.options.key) {
      this.logger.info(
        `Using private key passed via CLI --key flag for chain ${chain}`,
      );
      privateKey = this.options.key;
    } else if (ENV.HYP_KEY) {
      this.logger.info(`Using private key from .env for chain ${chain}`);
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

    this.logger.info(
      `Extracting private key from strategy config/user prompt for chain ${chain}`,
    );
    return strategyConfig.privateKey;
  }
}

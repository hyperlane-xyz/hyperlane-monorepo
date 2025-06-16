import { BigNumber, Signer } from 'ethers';
import { Logger } from 'pino';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProtocolProvider,
  MultiProvider,
  ProtocolMap,
  getLocalProvider,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ENV } from '../../../utils/env.js';

import {
  IMultiProtocolSigner,
  SignerConfig,
  TypedSigner,
} from './BaseMultiProtocolSigner.js';
import { MultiProtocolSignerFactory } from './MultiProtocolSignerFactory.js';

export interface MultiProtocolSignerOptions {
  logger?: Logger;
  key?: string | ProtocolMap<string>;
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
        this.multiProvider.getProtocol(chain) === ProtocolType.CosmosNative,
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
    const evmChains = this.chains.filter(
      (chain) =>
        this.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
    );

    for (const chain of evmChains) {
      const signer = await this.initSigner(chain);
      this.multiProvider.setSigner(chain, signer as Signer);
    }

    return this.multiProvider;
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
    for (const chain of this.compatibleChains) {
      const signerStrategy = this.signerStrategies.get(chain);
      if (signerStrategy) {
        await this.initSigner(chain);
      }
    }

    return this.signers;
  }

  /**
   * @notice Resolves single chain configuration
   */
  private async resolveConfig(
    chain: ChainName,
  ): Promise<{ chain: ChainName } & SignerConfig> {
    const { protocol } = this.multiProvider.getChainMetadata(chain);

    let config = await this.extractPrivateKey(chain);

    // For Cosmos, we get additional params
    if (protocol === ProtocolType.CosmosNative) {
      const provider =
        await this.multiProtocolProvider.getCosmJsNativeProvider(chain);
      const { bech32Prefix, gasPrice } =
        this.multiProvider.getChainMetadata(chain);

      config = {
        ...config,
        extraParams: { provider, prefix: bech32Prefix, gasPrice },
      };
    }

    return { chain, ...config };
  }

  /**
   * @notice Gets private key from strategy
   */
  private async extractPrivateKey(chain: ChainName): Promise<SignerConfig> {
    const protocol = this.multiProvider.getProtocol(chain);

    if (
      protocol === ProtocolType.Ethereum &&
      typeof this.options.key === 'string'
    ) {
      this.logger.debug(
        `Using private key passed via CLI --key flag for chain ${chain}`,
      );
      return { privateKey: this.options.key };
    }

    if (typeof this.options.key === 'object') {
      assert(
        this.options.key[protocol],
        `Key flag --key.${protocol} for chain ${chain} not provided`,
      );
      this.logger.debug(
        `Using private key passed via CLI --key.${protocol} flag for chain ${chain}`,
      );
      return { privateKey: this.options.key[protocol] };
    }

    if (process.env[`HYP_KEY_${protocol.toUpperCase()}`]) {
      this.logger.debug(`Using private key from .env for chain ${chain}`);
      return { privateKey: process.env[`HYP_KEY_${protocol.toUpperCase()}`]! };
    }

    if (protocol === ProtocolType.Ethereum) {
      if (ENV.HYP_KEY) {
        this.logger.debug(`Using private key from .env for chain ${chain}`);
        return { privateKey: ENV.HYP_KEY };
      }
    }

    const signerStrategy = this.getSignerStrategyOrFail(chain);
    const strategyConfig = await signerStrategy.getSignerConfig(chain);
    assert(
      strategyConfig.privateKey,
      `No private key found for chain ${chain}`,
    );
    this.logger.debug(
      `Extracting private key from strategy config/user prompt for chain ${chain}`,
    );

    return { privateKey: strategyConfig.privateKey };
  }

  private getSignerStrategyOrFail(chain: ChainName): IMultiProtocolSigner {
    const strategy = this.signerStrategies.get(chain);
    assert(strategy, `No signer strategy found for chain ${chain}`);
    return strategy;
  }

  protected getSpecificSigner<T>(chain: ChainName): T {
    return this.signers.get(chain) as T;
  }

  getEVMSigner(chain: ChainName): Signer {
    const protocolType = this.multiProvider.getChainMetadata(chain).protocol;
    assert(
      protocolType === ProtocolType.Ethereum,
      `Chain ${chain} is not an Ethereum chain`,
    );
    return this.getSpecificSigner<Signer>(chain);
  }

  getCosmosNativeSigner(chain: ChainName): SigningHyperlaneModuleClient {
    const protocolType = this.multiProvider.getProtocol(chain);
    assert(
      protocolType === ProtocolType.CosmosNative,
      `Chain ${chain} is not a Cosmos Native chain`,
    );
    return this.getSpecificSigner<SigningHyperlaneModuleClient>(chain);
  }

  async getAddress(chain: ChainName): Promise<Address> {
    const metadata = this.multiProvider.getChainMetadata(chain);

    switch (metadata.protocol) {
      case ProtocolType.Ethereum: {
        const signer = this.getEVMSigner(chain);
        return signer.getAddress();
      }
      case ProtocolType.CosmosNative: {
        const signer = this.getCosmosNativeSigner(chain);
        return signer.account.address;
      }
      default: {
        throw new Error(`Protocol Type ${metadata.protocol} not supported`);
      }
    }
  }

  async getBalance(
    isDryRun: boolean,
    address: Address,
    chain: ChainName,
    denom?: string,
  ): Promise<BigNumber> {
    const metadata = this.multiProvider.getChainMetadata(chain);

    switch (metadata.protocol) {
      case ProtocolType.Ethereum: {
        const provider = isDryRun
          ? getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT)
          : this.multiProvider.getProvider(chain);
        const balance = await provider.getBalance(address);
        return balance;
      }
      case ProtocolType.CosmosNative: {
        assert(denom, 'need denom to get balance of Cosmos Native chain');
        const provider =
          await this.multiProtocolProvider.getCosmJsNativeProvider(chain);
        const balance = await provider.getBalance(address, denom);
        return BigNumber.from(balance.amount);
      }
      default: {
        throw new Error(`Protocol Type ${metadata.protocol} not supported`);
      }
    }
  }
}

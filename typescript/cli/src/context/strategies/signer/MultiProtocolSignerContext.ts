import { Signer } from 'ethers';

import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { ENV } from '../../../utils/env.js';

import { IMultiProtocolSigner } from './BaseMultiProtocolSigner.js';
import { MultiProtocolSignerFactory } from './MultiProtocolSignerFactory.js';

/**
 * @title MultiProtocolSignerContext
 * @dev Manages the context for transaction submitters, including retrieving signers config and signers.
 */
export class MultiProtocolSignerContext {
  private signerStrategies: Map<ChainName, IMultiProtocolSigner> = new Map();

  constructor(
    strategyConfig: ChainSubmissionStrategy,
    private chains: ChainName[],
    private multiProvider: MultiProvider,
    private key?: string,
  ) {
    // Initialize chain-specific strategies
    for (const chain of chains) {
      const strategy = MultiProtocolSignerFactory.getSignerStrategy(
        chain,
        strategyConfig,
        multiProvider,
      );
      this.signerStrategies.set(chain, strategy);
    }
  }

  /**
   * @dev Retrieves the signers config for the specified chains.
   * @return An array of objects containing chain names and their corresponding signers config.
   */
  private async getSignersConfig(): Promise<
    Array<{ chain: ChainName; privateKey: string }>
  > {
    return Promise.all(
      this.chains.map((chain) => this.getSignerConfigForChain(chain)),
    );
  }

  /**
   * @notice This function retrieves private key from the strategy or falls back to the environment variable.
   */
  private async getSignerConfigForChain(
    chain: ChainName,
  ): Promise<{ chain: ChainName; privateKey: string }> {
    const signerStrategy = this.signerStrategies.get(chain);
    if (!signerStrategy) {
      throw new Error(`No signer strategy found for chain ${chain}`);
    }

    // Determine private key with clear precedence
    let privateKey: string;
    if (this.key) {
      privateKey = this.key;
    } else if (ENV.HYP_KEY) {
      privateKey = ENV.HYP_KEY;
    } else {
      const strategyConfig = await signerStrategy.getSignerConfig(chain);
      if (!strategyConfig?.privateKey) {
        throw new Error(`No private key found for chain ${chain}`);
      }
      privateKey = strategyConfig.privateKey;
    }

    return {
      chain,
      privateKey,
    };
  }

  /**
   * @dev Retrieves a signer for a specific chain based on its protocol.
   * @param chain The name of the chain for which to retrieve the signer.
   * @return A Promise that resolves to the Signer instance for the specified chain.
   * @throws Error if the protocol is unsupported.
   */
  async getSigner(chain: ChainName): Promise<Signer> {
    const { privateKey } = await this.getSignerConfigForChain(chain);

    const signerStrategy = this.signerStrategies.get(chain);
    if (!signerStrategy) {
      throw new Error(`No signer strategy found for chain ${chain}`);
    }
    return signerStrategy.getSigner({ privateKey });
  }

  /**
   * @dev Retrieves signers for the specified chains using their signers config.
   * @return A record mapping chain names to their corresponding Signer objects.
   */
  async getSigners(): Promise<Record<ChainName, Signer>> {
    const signerConfigs = await this.getSignersConfig();
    const result: Record<ChainName, Signer> = {};

    for (const { chain, privateKey } of signerConfigs) {
      const signerStrategy = this.signerStrategies.get(chain);
      if (signerStrategy) {
        result[chain] = signerStrategy.getSigner({ privateKey });
      }
    }

    return result;
  }

  /**
   * @dev Configures signers for all specified chains in the MultiProvider.
   * @return The updated MultiProvider instance.
   * @notice This function sets the signer for each chain based on its protocol.
   */
  async attachSignersToMp(): Promise<MultiProvider> {
    for (const chain of this.chains) {
      const signer = await this.getSigner(chain);
      this.multiProvider.setSigner(chain, signer);
    }

    return this.multiProvider;
  }
}

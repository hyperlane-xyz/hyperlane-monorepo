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
 * @title MultiProtocolSignerManager
 * @dev Context manager for signers across multiple protocols
 */
export class MultiProtocolSignerManager {
  private signerStrategies: Map<ChainName, IMultiProtocolSigner> = new Map();

  constructor(
    submissionStrategy: ChainSubmissionStrategy,
    private chains: ChainName[],
    private multiProvider: MultiProvider,
    private key?: string,
  ) {
    // Initialize chain-specific strategies
    for (const chain of chains) {
      const strategy = MultiProtocolSignerFactory.getSignerStrategy(
        chain,
        submissionStrategy,
        multiProvider,
      );
      this.signerStrategies.set(chain, strategy);
    }
  }

  /**
   * @dev Gets signers config for specified chains
   */
  private async getSignersConfig(): Promise<
    Array<{ chain: ChainName; privateKey: string }>
  > {
    return Promise.all(
      this.chains.map((chain) => this.getSignerConfigForChain(chain)),
    );
  }

  /**
   * @dev Gets private key from strategy or environment fallback
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
   * @dev Gets protocol-specific signer for a chain
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
   * @dev Gets signers for all specified chains
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
   * @dev Configures signers for chains in MultiProvider
   */
  async attachSignersToMp(): Promise<MultiProvider> {
    for (const chain of this.chains) {
      const signer = await this.getSigner(chain);
      this.multiProvider.setSigner(chain, signer);
    }

    return this.multiProvider;
  }
}

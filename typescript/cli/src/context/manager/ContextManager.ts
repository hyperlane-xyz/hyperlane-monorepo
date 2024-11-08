import { Signer } from 'ethers';

import { ChainName, TxSubmitterType } from '@hyperlane-xyz/sdk';

import { ENV } from '../../utils/env.js';
import { ISubmitterStrategy } from '../strategies/submitter/SubmitterStrategy.js';
import { SubmitterStrategyFactory } from '../strategies/submitter/SubmitterStrategyFactory.js';

/**
 * @title ContextManager
 * @dev Manages the context for transaction submitters, including retrieving chain keys and signers.
 */
export class ContextManager {
  private strategy: ISubmitterStrategy;

  /**
   * @param strategyConfig Configuration for the submitter strategy.
   * @param chains Array of chain names to manage.
   * @param submitterType Type of transaction submitter to use.
   */
  constructor(
    strategyConfig: any,
    private chains: ChainName[],
    submitterType: TxSubmitterType,
    private argv?: any,
  ) {
    this.strategy = SubmitterStrategyFactory.createStrategy(
      submitterType,
      strategyConfig,
    );
  }

  /**
   * @dev Retrieves the private keys for the specified chains.
   * @return An array of objects containing chain names and their corresponding private keys.
   */
  async getChainKeys(): Promise<
    Array<{ chainName: ChainName; privateKey: string }>
  > {
    const chainKeys = await Promise.all(
      this.chains.map(async (chain) => ({
        chainName: chain,
        privateKey:
          this.argv.key || // argv.key overrides strategy key
          (await this.strategy.getPrivateKey(chain)) ||
          ENV.HYP_KEY, // argv.key and ENV.HYP_KEY for backwards compatibility
      })),
    );

    return chainKeys;
  }

  /**
   * @dev Retrieves signers for the specified chains using their private keys.
   * @return A record mapping chain names to their corresponding Signer objects.
   */
  async getSigners(): Promise<Record<ChainName, Signer>> {
    const chainKeys = await this.getChainKeys();
    return Object.fromEntries(
      chainKeys.map(({ chainName, privateKey }) => [
        chainName,
        this.strategy.getSigner(privateKey),
      ]),
    );
  }
}

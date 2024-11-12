import { Signer } from 'ethers';

import {
  ChainName,
  ChainSubmissionStrategy,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { ENV } from '../../../utils/env.js';

import { ISubmitterStrategy } from './SubmitterStrategy.js';
import { SubmitterStrategyFactory } from './SubmitterStrategyFactory.js';

/**
 * @title SubmitterContext
 * @dev Manages the context for transaction submitters, including retrieving chain keys and signers.
 */
export class SubmitterContext {
  private strategy: ISubmitterStrategy;

  /**
   * @param strategyConfig Configuration for the submitter strategy.
   * @param chains Array of chain names to manage.
   * @param submitterType Type of transaction submitter to use.
   */
  constructor(
    strategyConfig: ChainSubmissionStrategy,
    private chains: ChainName[],
    submitterType: TxSubmitterType,
    private argv?: Record<string, any>,
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
  private async getChainKeys(): Promise<
    Array<{ chainName: ChainName; privateKey: string }>
  > {
    const chainKeys = [];

    for (const chain of this.chains) {
      const privateKey =
        this.argv?.key ?? // argv.key overrides strategy private key
        (await this.strategy.getPrivateKey(chain)) ??
        ENV.HYP_KEY; // argv.key and ENV.HYP_KEY for backwards compatibility

      chainKeys.push({
        chainName: chain,
        privateKey: privateKey,
      });
    }

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

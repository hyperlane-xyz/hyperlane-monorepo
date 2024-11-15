import { Signer, Wallet } from 'ethers';

import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

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
   * @param multiProvider MultiProvider instance for managing multiple chains.
   * @param key Optional private key for overriding strategy private key.
   */
  constructor(
    strategyConfig: ChainSubmissionStrategy,
    private chains: ChainName[],
    submitterType: TxSubmitterType,
    private multiProvider: MultiProvider,
    private key?: string,
  ) {
    this.strategy = SubmitterStrategyFactory.createStrategy(
      submitterType,
      strategyConfig,
    );
  }

  /**
   * @dev Retrieves the private keys for the specified chains.
   * @return An array of objects containing chain names and their corresponding private keys.
   * @notice This function retrieves private keys from the strategy or falls back to the environment variable.
   */
  private async getChainKeys(): Promise<
    Array<{ chainName: ChainName; privateKey: string }>
  > {
    const chainKeys = [];

    for (const chain of this.chains) {
      const privateKey =
        this?.key ?? // argv.key overrides strategy private key
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
    this.strategy;
    const chainKeys = await this.getChainKeys();
    return Object.fromEntries(
      chainKeys.map(({ chainName, privateKey }) => [
        chainName,
        this.strategy.getSigner(privateKey),
      ]),
    );
  }

  /**
   * @dev Configures signers for all specified chains in the MultiProvider.
   * @return The updated MultiProvider instance.
   * @notice This function sets the signer for each chain based on its protocol.
   */
  async configureSigners(): Promise<MultiProvider> {
    for (const chain of this.chains) {
      const signer = await this.getSignerForChain(chain);
      this.multiProvider.setSigner(chain, signer);
    }

    return this.multiProvider;
  }

  /**
   * @dev Retrieves a signer for a specific chain based on its protocol.
   * @param chain The name of the chain for which to retrieve the signer.
   * @param protocol The protocol type of the chain.
   * @return A Promise that resolves to the Signer instance for the specified chain.
   * @throws Error if the protocol is unsupported.
   */
  async getSignerForChain(chain: ChainName): Promise<any> {
    const { protocol } = this.multiProvider.getChainMetadata(chain);

    const privateKey =
      this?.key ?? // argv.key overrides strategy private key
      ENV.HYP_KEY ?? // ENV.HYP_KEY overrides strategy/prompt to enter pk
      (await this.strategy.getPrivateKey(chain));

    // If protocol is starknet, prompt for address input

    switch (protocol) {
      case ProtocolType.Ethereum:
        // Example for ZKSync
        // if (technicalStack === ChainTechnicalStack.ZkSync)
        //   return new ZKSyncWallet(privateKey);
        return new Wallet(privateKey);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}

import { createAccountWithAddress } from '@turnkey/viem';
import { Hex } from 'viem';
import { LocalAccount } from 'viem/accounts';

import { rootLogger } from '@hyperlane-xyz/utils';
import type {
  EvmBigNumberish,
  EvmGasAmount,
  EvmProviderLike,
  EvmTransactionReceiptLike,
  EvmTransactionLike,
  EvmTransactionResponseLike,
} from '../../providers/evmTypes.js';

import {
  TurnkeyClientManager,
  TurnkeyConfig,
  logTurnkeyError,
} from '../turnkeyClient.js';

import {
  TypedDataDomainLike,
  TypedDataTypesLike,
  TypedDataValueLike,
  getTypedDataPrimaryType,
  ViemProviderLike,
  ViemTransactionRequestLike,
  toBigIntValue,
  toSerializableViemTransaction,
  toSignableMessage,
} from './types.js';

const logger = rootLogger.child({ module: 'sdk:turnkey-evm' });

export type TurnkeyViemTransactionRequest = ViemTransactionRequestLike & {
  data?: Hex;
};

/**
 * Turnkey signer for EVM transactions
 * Uses Turnkey's secure enclaves to sign transactions without exposing private keys
 * This is a custom EVM signer that uses Turnkey SDK directly.
 * Uses composition to access Turnkey functionality.
 *
 * @example
 * ```typescript
 * const config: TurnkeyConfig = {
 *   organizationId: 'your-org-id',
 *   apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
 *   apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
 *   privateKeyId: 'your-private-key-id',
 *   publicKey: '0x...', // Ethereum address
 * };
 *
 * const provider = multiProvider.getProvider('ethereum');
 * const signer = new TurnkeyViemSigner(config, provider);
 *
 * // Use with MultiProvider
 * multiProvider.setSigner('ethereum', signer);
 * ```
 */
export class TurnkeyViemSigner {
  private readonly manager: TurnkeyClientManager;
  private readonly account: LocalAccount;
  public readonly address: string;
  public readonly provider: ViemProviderLike | undefined;

  constructor(config: TurnkeyConfig, provider?: ViemProviderLike) {
    this.manager = new TurnkeyClientManager(config);
    this.address = config.publicKey;
    this.provider = provider;
    this.account = createAccountWithAddress({
      client: this.manager.getClient(),
      organizationId: config.organizationId,
      signWith: config.privateKeyId,
      ethereumAddress: this.address,
    });

    logger.debug(`Initialized Turnkey EVM signer for key: ${this.address}`);
  }

  private toViemProviderLike(
    provider: ViemProviderLike | EvmProviderLike,
  ): ViemProviderLike {
    const candidate = provider as Record<string, unknown>;
    if (
      typeof candidate.estimateGas !== 'function' ||
      typeof candidate.getFeeData !== 'function' ||
      typeof candidate.getNetwork !== 'function' ||
      typeof candidate.getTransactionCount !== 'function' ||
      typeof candidate.sendTransaction !== 'function'
    ) {
      throw new Error(
        'Provider does not satisfy TurnkeyViemSigner requirements',
      );
    }
    return provider as ViemProviderLike;
  }

  /**
   * Health check - delegates to manager
   */
  async healthCheck(): Promise<boolean> {
    return this.manager.healthCheck();
  }

  /**
   * Get an ethers Signer connected to the provided provider
   * This returns a new instance with the provider connected
   */
  async getSigner(
    provider: ViemProviderLike | EvmProviderLike,
  ): Promise<TurnkeyViemSigner> {
    logger.debug('Creating Turnkey EVM signer for transaction');
    return this.connect(provider);
  }

  /**
   * Connect this signer to a provider (creates new instance with proper configuration)
   */
  connect(provider: ViemProviderLike | EvmProviderLike): TurnkeyViemSigner {
    return new TurnkeyViemSigner(
      this.manager.getConfig(),
      this.toViemProviderLike(provider),
    );
  }

  /**
   * Get the address of this signer
   */
  async getAddress(): Promise<string> {
    return this.address;
  }

  /**
   * Sign a transaction using Turnkey
   */
  async signTransaction(
    transaction: TurnkeyViemTransactionRequest,
  ): Promise<string> {
    if (!this.provider) {
      throw new Error('Provider required to sign transaction');
    }

    logger.debug('Signing transaction with Turnkey', {
      to: transaction.to,
      value: transaction.value?.toString(),
    });

    try {
      const populatedTx = await this.populateTransaction(transaction);
      const signedTx = await this.account.signTransaction(
        toSerializableViemTransaction(populatedTx),
      );

      logger.debug('Transaction signed successfully');
      return signedTx.startsWith('0x') ? signedTx : `0x${signedTx}`;
    } catch (error) {
      logTurnkeyError('Failed to sign transaction with Turnkey', error);
      throw error;
    }
  }

  /**
   * Sign a message using Turnkey
   */
  async signMessage(message: string | Uint8Array): Promise<string> {
    logger.debug('Signing message with Turnkey');

    try {
      const signature = await this.account.signMessage({
        message: toSignableMessage(message),
      });
      logger.debug('Message signed successfully');
      return signature;
    } catch (error) {
      logTurnkeyError('Failed to sign message with Turnkey', error);
      throw error;
    }
  }

  async signTypedData(
    domain: TypedDataDomainLike,
    types: TypedDataTypesLike,
    value: TypedDataValueLike,
  ): Promise<string> {
    const primaryType = getTypedDataPrimaryType(types);
    const signRequest: Parameters<typeof this.account.signTypedData>[0] = {
      domain: domain as Parameters<
        typeof this.account.signTypedData
      >[0]['domain'],
      types: types as Parameters<typeof this.account.signTypedData>[0]['types'],
      primaryType: primaryType as Parameters<
        typeof this.account.signTypedData
      >[0]['primaryType'],
      message: value as Parameters<
        typeof this.account.signTypedData
      >[0]['message'],
    };
    return this.account.signTypedData(signRequest);
  }

  async _signTypedData(
    domain: TypedDataDomainLike,
    types: TypedDataTypesLike,
    value: TypedDataValueLike,
  ): Promise<string> {
    return this.signTypedData(domain, types, value);
  }

  async estimateGas(transaction: EvmTransactionLike): Promise<EvmGasAmount> {
    if (!this.provider) throw new Error('Provider required to estimate gas');
    const estimate = await this.provider.estimateGas(
      transaction as TurnkeyViemTransactionRequest,
    );
    const asBigInt = toBigIntValue(estimate);
    if (asBigInt !== undefined) return asBigInt;
    return estimate as { toString(): string };
  }

  async getBalance(): Promise<EvmBigNumberish> {
    if (!this.provider) throw new Error('Provider required to get balance');
    if (typeof this.provider.getBalance === 'function') {
      const balance = await this.provider.getBalance(this.address);
      if (
        typeof balance === 'string' ||
        typeof balance === 'number' ||
        typeof balance === 'bigint'
      ) {
        return balance;
      }
      if (
        balance &&
        typeof (balance as { toString?: unknown }).toString === 'function'
      ) {
        return balance as { toString(): string };
      }
      throw new Error('Unable to convert balance');
    }
    if (typeof this.provider.send === 'function') {
      const balance = await this.provider.send('eth_getBalance', [
        this.address,
        'latest',
      ]);
      if (
        typeof balance === 'string' ||
        typeof balance === 'number' ||
        typeof balance === 'bigint'
      ) {
        return balance;
      }
      if (
        balance &&
        typeof (balance as { toString?: unknown }).toString === 'function'
      ) {
        return balance as { toString(): string };
      }
      throw new Error('Unable to convert balance');
    }
    throw new Error('Provider does not support getBalance');
  }

  async sendTransaction(
    tx: EvmTransactionLike,
  ): Promise<EvmTransactionResponseLike> {
    if (!this.provider)
      throw new Error('Provider required to send transaction');
    const signedTransaction = await this.signTransaction(
      tx as TurnkeyViemTransactionRequest,
    );
    const response = await this.provider.sendTransaction(signedTransaction);
    return {
      ...response,
      hash: response.hash,
      wait: async (confirmations?: number) =>
        (await response.wait(
          confirmations,
        )) as EvmTransactionReceiptLike | null,
    };
  }

  /**
   * Populate a transaction with default values (nonce, gas, etc.)
   */
  async populateTransaction(
    transaction: TurnkeyViemTransactionRequest,
  ): Promise<TurnkeyViemTransactionRequest> {
    if (!this.provider) {
      throw new Error('Provider required to populate transaction');
    }

    const tx = { ...transaction };

    // Set from address
    if (!tx.from) {
      tx.from = this.address;
    }

    // Get nonce if not set
    if (tx.nonce == null) {
      tx.nonce = await this.provider.getTransactionCount(
        this.address,
        'pending',
      );
    }

    // Get gas price if not set
    if (tx.gasPrice == null && tx.maxFeePerGas == null) {
      const feeData = await this.provider.getFeeData();
      if (feeData.maxFeePerGas) {
        tx.maxFeePerGas = toBigIntValue(feeData.maxFeePerGas);
        tx.maxPriorityFeePerGas =
          toBigIntValue(feeData.maxPriorityFeePerGas) || undefined;
      } else {
        tx.gasPrice = toBigIntValue(feeData.gasPrice) || undefined;
      }
    }

    // Get chain ID if not set
    if (tx.chainId == null) {
      const network = await this.provider.getNetwork();
      tx.chainId = network.chainId;
    }

    if (tx.gas == null && tx.gasLimit == null) {
      tx.gas = toBigIntValue(await this.provider.estimateGas(tx));
    } else if (tx.gas == null && tx.gasLimit != null) {
      tx.gas = toBigIntValue(tx.gasLimit);
    }

    delete tx.gasLimit;
    return tx;
  }
}

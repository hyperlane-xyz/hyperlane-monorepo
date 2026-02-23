import { createAccountWithAddress } from '@turnkey/viem';
import { Hex } from 'viem';
import { LocalAccount } from 'viem/accounts';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  TurnkeyClientManager,
  TurnkeyConfig,
  logTurnkeyError,
} from '../turnkeyClient.js';

const logger = rootLogger.child({ module: 'sdk:turnkey-evm' });

type EvmProviderLike = {
  estimateGas(transaction: TurnkeyTransactionRequest): Promise<unknown>;
  getFeeData(): Promise<{
    gasPrice?: unknown;
    maxFeePerGas?: unknown;
    maxPriorityFeePerGas?: unknown;
  }>;
  getNetwork(): Promise<{ chainId: number }>;
  getTransactionCount(address: string, blockTag?: string): Promise<number>;
  sendTransaction(signedTransaction: string): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<unknown>;
  }>;
};

type TurnkeyTransactionRequest = {
  chainId?: number;
  data?: Hex;
  from?: string;
  gas?: unknown;
  gasLimit?: unknown;
  gasPrice?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  nonce?: number;
  to?: string;
  type?: number;
  value?: unknown;
};

const toBigIntValue = (value: unknown): bigint | undefined =>
  value === null || value === undefined ? undefined : BigInt(value.toString());

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
 * const signer = new TurnkeyEvmSigner(config, provider);
 *
 * // Use with MultiProvider
 * multiProvider.setSigner('ethereum', signer);
 * ```
 */
export class TurnkeyEvmSigner {
  private readonly manager: TurnkeyClientManager;
  private readonly account: LocalAccount;
  public readonly address: string;
  public readonly provider: EvmProviderLike | undefined;

  constructor(config: TurnkeyConfig, provider?: EvmProviderLike) {
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
  async getSigner(provider: EvmProviderLike): Promise<TurnkeyEvmSigner> {
    logger.debug('Creating Turnkey EVM signer for transaction');
    return this.connect(provider);
  }

  /**
   * Connect this signer to a provider (creates new instance with proper configuration)
   */
  connect(provider: EvmProviderLike): TurnkeyEvmSigner {
    return new TurnkeyEvmSigner(this.manager.getConfig(), provider);
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
    transaction: TurnkeyTransactionRequest,
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
      const { from: _from, gasLimit, ...tx } = populatedTx;
      const isEip1559 = !!(tx.maxFeePerGas || tx.maxPriorityFeePerGas);
      const signedTx = await this.account.signTransaction({
        ...tx,
        to: tx.to as `0x${string}` | undefined,
        gas: toBigIntValue(tx.gas ?? gasLimit),
        value: toBigIntValue(tx.value),
        gasPrice: isEip1559 ? undefined : toBigIntValue(tx.gasPrice),
        maxFeePerGas: toBigIntValue(tx.maxFeePerGas),
        maxPriorityFeePerGas: toBigIntValue(tx.maxPriorityFeePerGas),
        type: isEip1559 ? 'eip1559' : undefined,
      } as any);

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
        message: message as any,
      });
      logger.debug('Message signed successfully');
      return signature;
    } catch (error) {
      logTurnkeyError('Failed to sign message with Turnkey', error);
      throw error;
    }
  }

  async sendTransaction(
    tx: TurnkeyTransactionRequest,
  ): Promise<{ hash: string; wait(confirmations?: number): Promise<unknown> }> {
    if (!this.provider)
      throw new Error('Provider required to send transaction');
    const signedTransaction = await this.signTransaction(tx);
    return this.provider.sendTransaction(signedTransaction);
  }

  /**
   * Populate a transaction with default values (nonce, gas, etc.)
   */
  async populateTransaction(
    transaction: TurnkeyTransactionRequest,
  ): Promise<TurnkeyTransactionRequest> {
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

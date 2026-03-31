import { PublicKey, Transaction } from '@solana/web3.js';
import { TurnkeySigner as TurnkeySolanaSigner } from '@turnkey/solana';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  TurnkeyClientManager,
  TurnkeyConfig,
  logTurnkeyError,
} from '../turnkeyClient.js';

import { SvmTransactionSigner } from './solana-web3js.js';

const logger = rootLogger.child({ module: 'sdk:turnkey-sealevel' });

/**
 * Turnkey signer for Solana/SVM transactions
 * Provides a Keypair-like interface but signs transactions using Turnkey's secure enclaves
 * Uses composition to access Turnkey functionality while implementing SVM interface
 *
 * @example
 * ```typescript
 * const config: TurnkeyConfig = {
 *   organizationId: 'your-org-id',
 *   apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
 *   apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
 *   privateKeyId: 'your-private-key-id',
 *   publicKey: 'base58-solana-pubkey',
 * };
 *
 * const signer = new TurnkeySealevelSigner(config);
 *
 * // Use with SvmMultiProtocolSignerAdapter
 * const adapter = new SvmMultiProtocolSignerAdapter(
 *   'solana',
 *   signer,
 *   multiProtocolProvider
 * );
 * ```
 */
export class TurnkeySealevelSigner implements SvmTransactionSigner {
  private readonly manager: TurnkeyClientManager;
  private readonly turnkeySigner: TurnkeySolanaSigner;
  public readonly publicKey: PublicKey;

  constructor(config: TurnkeyConfig) {
    this.manager = new TurnkeyClientManager(config);

    this.turnkeySigner = new TurnkeySolanaSigner({
      organizationId: this.manager.getOrganizationId(),
      client: this.manager.getClient(),
    });

    this.publicKey = new PublicKey(config.publicKey);

    logger.debug(
      `Initialized Turnkey Sealevel signer for key: ${this.publicKey}`,
    );
  }

  /**
   * Health check - delegates to manager
   */
  async healthCheck(): Promise<boolean> {
    return this.manager.healthCheck();
  }

  /**
   * Get a signer (returns this instance)
   */
  async getSigner(): Promise<this> {
    return this;
  }

  /**
   * Sign a Solana transaction using Turnkey
   * This method uses Turnkey's secure enclave to sign the transaction
   * and enforces any policies configured in Turnkey (e.g., IGP-only restrictions)
   */
  async signTransaction(transaction: Transaction): Promise<Transaction> {
    logger.debug('Signing transaction with Turnkey');

    try {
      // Use Turnkey's Solana signer to sign the transaction
      // This uses the ACTIVITY_TYPE_SIGN_TRANSACTION_V2 activity type
      const signedTx = await this.turnkeySigner.signTransaction(
        // @ts-ignore work around @solana/web3.js version mismatch
        transaction,
        this.publicKey.toBase58(),
        this.manager.getOrganizationId(),
      );

      logger.debug('Transaction signed successfully');
      // Return the transaction (Turnkey modifies it in place or returns the same type)
      // @ts-ignore work around @solana/web3.js version mismatch
      return signedTx;
    } catch (error) {
      logTurnkeyError('Failed to sign transaction with Turnkey', error);
      throw error;
    }
  }
}

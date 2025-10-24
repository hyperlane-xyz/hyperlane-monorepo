import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { TurnkeyServerClient } from '@turnkey/sdk-server';
import { TurnkeySigner } from '@turnkey/solana';

import { SvmTransactionSigner } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/environment.js';

import { fetchLatestGCPSecret } from './gcloud.js';

const logger = rootLogger.child({ module: 'infra:turnkey-sealevel' });

export const turnkeySvmDeployerSecret = (
  deployEnvironment: DeployEnvironment,
) => `${deployEnvironment}-turnkey-sealevel-deployer`;

export type TurnkeyConfig = {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  privateKeyId: string;
  publicKey: string;
};

/**
 * Turnkey signer for Solana/SVM transactions
 * Provides a Keypair-like interface but signs transactions using Turnkey's secure enclaves
 */
export class TurnkeySealevelSigner implements SvmTransactionSigner {
  private client: TurnkeyServerClient;
  private turnkeySigner: TurnkeySigner;
  private organizationId: string;
  private privateKeyId: string;
  public readonly publicKey: PublicKey;

  constructor(config: TurnkeyConfig) {
    const stamper = new ApiKeyStamper({
      apiPublicKey: config.apiPublicKey,
      apiPrivateKey: config.apiPrivateKey,
    });

    this.client = new TurnkeyServerClient({
      organizationId: config.organizationId,
      stamper,
      apiBaseUrl: 'https://api.turnkey.com',
    });

    this.turnkeySigner = new TurnkeySigner({
      organizationId: config.organizationId,
      client: this.client,
    });

    this.organizationId = config.organizationId;
    this.privateKeyId = config.privateKeyId;
    // Use public key from config
    this.publicKey = new PublicKey(config.publicKey);

    logger.info(
      `Initialized Turnkey signer for key: ${this.privateKeyId.slice(0, 8)}...`,
    );
    logger.info(`Public key: ${this.publicKey.toBase58()}`);
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
        this.organizationId,
      );

      logger.debug('Transaction signed successfully');
      // Return the transaction (Turnkey modifies it in place or returns the same type)
      // @ts-ignore work around @solana/web3.js version mismatch
      return signedTx;
    } catch (error) {
      logger.error('Failed to sign transaction with Turnkey:', error);
      throw error;
    }
  }

  /**
   * Check if Turnkey is properly configured and accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      logger.debug('Running Turnkey health check...');

      // Try to get the current user/org info
      const whoami = await this.client.getWhoami({
        organizationId: this.organizationId,
      });

      logger.debug(
        `Turnkey health check passed. Organization ID: ${whoami.organizationId}`,
      );
      return true;
    } catch (error) {
      logger.error('Turnkey health check failed:', error);
      return false;
    }
  }
}

export async function getTurnkeySealevelDeployerSigner(
  deployEnvironment: DeployEnvironment,
): Promise<TurnkeySealevelSigner> {
  try {
    const secretData = await fetchLatestGCPSecret(
      turnkeySvmDeployerSecret(deployEnvironment),
    );
    const turnkeyConfig = JSON.parse(secretData) as TurnkeyConfig;
    const signer = new TurnkeySealevelSigner(turnkeyConfig);

    // Run health check
    const healthy = await signer.healthCheck();
    if (!healthy) {
      throw new Error('Turnkey health check failed after initialization');
    }

    return signer;
  } catch (error) {
    rootLogger.error('Failed to initialize Turnkey signer:', error);
    rootLogger.error(
      `Ensure the Turnkey config is stored in GCP Secret Manager:\n` +
        `  Secret name: ${deployEnvironment}-turnkey-sealevel-deployer\n` +
        `  Secret format: JSON with fields organizationId, apiPublicKey, apiPrivateKey, privateKeyId, publicKey`,
    );
    throw error;
  }
}

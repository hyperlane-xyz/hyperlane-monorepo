import { PublicKey, Transaction } from '@solana/web3.js';
import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { TurnkeyServerClient } from '@turnkey/sdk-server';
import { TurnkeySigner as TurnkeySolanaSigner } from '@turnkey/solana';
import { ethers } from 'ethers';

import { MultiProvider, SvmTransactionSigner } from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/environment.js';
import { TurnkeyRole } from '../roles.js';

import { fetchLatestGCPSecret } from './gcloud.js';

const logger = rootLogger.child({ module: 'infra:turnkey' });

export type TurnkeySigner = TurnkeySealevelSigner | TurnkeyEvmSigner;

/**
 * Get the GCP secret name for a Turnkey role
 */
export const turnkeySecret = (
  deployEnvironment: DeployEnvironment,
  role: TurnkeyRole,
) => `${deployEnvironment}-turnkey-${role}`;

// Legacy helper for backwards compatibility
export const turnkeySvmDeployerSecret = (
  deployEnvironment: DeployEnvironment,
) => turnkeySecret(deployEnvironment, TurnkeyRole.SealevelDeployer);

/**
 * Unified Turnkey configuration for both Sealevel and EVM keys
 * The publicKey field contains:
 * - For Sealevel: base58-encoded Solana public key
 * - For EVM: hex-encoded Ethereum address
 */
export type TurnkeyConfig = {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  privateKeyId: string;
  publicKey: string;
};

/**
 * Base class containing shared Turnkey client initialization and health check logic
 */
abstract class BaseTurnkeySigner {
  protected readonly client: TurnkeyServerClient;
  protected readonly organizationId: string;
  protected readonly privateKeyId: string;

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

    this.organizationId = config.organizationId;
    this.privateKeyId = config.privateKeyId;
  }

  /**
   * Check if Turnkey is properly configured and accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      logger.debug('Running Turnkey health check...');

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

/**
 * Generic helper to create and health-check a Turnkey signer from GCP Secret Manager
 */
export async function createTurnkeySigner(
  deployEnvironment: DeployEnvironment,
  role: TurnkeyRole,
): Promise<TurnkeySigner> {
  const secretName = turnkeySecret(deployEnvironment, role);
  try {
    const secretData = await fetchLatestGCPSecret(secretName);
    const turnkeyConfig = JSON.parse(secretData) as TurnkeyConfig;

    // Create the appropriate signer based on role
    let signer: TurnkeySigner;
    switch (role) {
      case TurnkeyRole.SealevelDeployer:
        signer = new TurnkeySealevelSigner(turnkeyConfig);
        break;
      case TurnkeyRole.EvmDeployer:
      case TurnkeyRole.EvmLegacyDeployer:
      case TurnkeyRole.EvmRebalancer:
      case TurnkeyRole.EvmIgpClaimer:
      case TurnkeyRole.EvmIgpUpdater:
        signer = new TurnkeyEvmSigner(turnkeyConfig);
        break;
      default:
        throw new Error(`Unknown Turnkey role: ${role}`);
    }

    // Run health check
    const healthy = await signer.healthCheck();
    if (!healthy) {
      throw new Error('Turnkey health check failed after initialization');
    }

    return signer;
  } catch (error) {
    rootLogger.error(`Failed to initialize Turnkey ${role} signer:`, error);
    rootLogger.error(
      `Ensure the Turnkey config is stored in GCP Secret Manager:\n` +
        `  Secret name: ${secretName}\n` +
        `  Secret format: JSON with fields organizationId, apiPublicKey, apiPrivateKey, privateKeyId, publicKey`,
    );
    throw error;
  }
}

/**
 * Turnkey signer for Solana/SVM transactions
 * Provides a Keypair-like interface but signs transactions using Turnkey's secure enclaves
 */
export class TurnkeySealevelSigner
  extends BaseTurnkeySigner
  implements SvmTransactionSigner
{
  private turnkeySigner: TurnkeySolanaSigner;
  public readonly publicKey: PublicKey;

  constructor(config: TurnkeyConfig) {
    super(config);

    this.turnkeySigner = new TurnkeySolanaSigner({
      organizationId: config.organizationId,
      client: this.client,
    });

    this.publicKey = new PublicKey(config.publicKey);

    logger.info(
      `Initialized Turnkey Sealevel signer for key: ${this.publicKey}`,
    );
  }

  /**
   * Get a signer (returns this for compatibility with CloudAgentKey interface)
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
}

export async function getTurnkeySealevelDeployerSigner(
  deployEnvironment: DeployEnvironment,
): Promise<TurnkeySealevelSigner> {
  return createTurnkeySigner(
    deployEnvironment,
    TurnkeyRole.SealevelDeployer,
  ) as Promise<TurnkeySealevelSigner>;
}

/**
 * Turnkey signer for EVM transactions
 * Uses Turnkey's secure enclaves to sign transactions without exposing private keys
 * This is a custom ethers v5-compatible Signer that uses Turnkey SDK directly
 */
export class TurnkeyEvmSigner extends ethers.Signer implements ethers.Signer {
  private readonly client: TurnkeyServerClient;
  private readonly organizationId: string;
  private readonly privateKeyId: string;
  public readonly address: string;
  public readonly provider: ethers.providers.Provider | undefined;

  constructor(config: TurnkeyConfig, provider?: ethers.providers.Provider) {
    super();

    const stamper = new ApiKeyStamper({
      apiPublicKey: config.apiPublicKey,
      apiPrivateKey: config.apiPrivateKey,
    });

    this.client = new TurnkeyServerClient({
      organizationId: config.organizationId,
      stamper,
      apiBaseUrl: 'https://api.turnkey.com',
    });

    this.organizationId = config.organizationId;
    this.privateKeyId = config.privateKeyId;
    this.address = config.publicKey;
    this.provider = provider;

    logger.info(`Initialized Turnkey EVM signer for key: ${this.address}`);
  }

  /**
   * Get an ethers Signer connected to the provided provider
   * This returns a new instance with the provider connected
   */
  async getSigner(provider: ethers.providers.Provider): Promise<ethers.Signer> {
    logger.debug('Creating Turnkey EVM signer for transaction');
    return this.connect(provider);
  }

  /**
   * Check if Turnkey is properly configured and accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      logger.debug('Running Turnkey health check...');

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

  /**
   * Connect this signer to a provider
   */
  connect(provider: ethers.providers.Provider): TurnkeyEvmSigner {
    const connectedSigner = Object.create(this);
    connectedSigner.provider = provider;
    return connectedSigner;
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
    transaction: ethers.providers.TransactionRequest,
  ): Promise<string> {
    if (!this.provider) {
      throw new Error('Provider required to sign transaction');
    }

    logger.debug('Signing transaction with Turnkey', {
      to: transaction.to,
      value: transaction.value?.toString(),
    });

    try {
      // Populate the transaction (fill in nonce, gasPrice, etc.)
      const populatedTx = await ethers.utils.resolveProperties(
        await this.populateTransaction(transaction),
      );

      // Remove 'from' field for serialization
      const { from, ...txToSerialize } = populatedTx;

      // For EIP-1559 transactions, explicitly set type: 2 and remove gasPrice
      if (txToSerialize.maxFeePerGas || txToSerialize.maxPriorityFeePerGas) {
        txToSerialize.type = 2;
        delete txToSerialize.gasPrice;
      }

      const unsignedTx = ethers.utils.serializeTransaction(
        txToSerialize as ethers.utils.UnsignedTransaction,
      );

      // Remove 0x prefix for Turnkey API (it expects raw hex)
      const unsignedTxHex = unsignedTx.startsWith('0x')
        ? unsignedTx.slice(2)
        : unsignedTx;

      // Sign using Turnkey's signTransaction API
      const { activity } = await this.client.signTransaction({
        signWith: this.address,
        type: 'TRANSACTION_TYPE_ETHEREUM',
        unsignedTransaction: unsignedTxHex,
      });

      // Check that the activity completed
      if (activity.status !== 'ACTIVITY_STATUS_COMPLETED') {
        throw new Error(
          `Transaction signing activity did not complete. Status: ${activity.status}`,
        );
      }

      const signedTx =
        activity.result?.signTransactionResult?.signedTransaction;
      if (!signedTx) {
        throw new Error('No signed transaction returned from Turnkey');
      }

      logger.debug('Transaction signed successfully');
      // Ensure the signed transaction has 0x prefix
      return signedTx.startsWith('0x') ? signedTx : `0x${signedTx}`;
    } catch (error) {
      logger.error('Failed to sign transaction with Turnkey:', error);
      throw error;
    }
  }

  /**
   * Sign a message using Turnkey
   */
  async signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    logger.debug('Signing message with Turnkey');

    try {
      const messageBytes =
        typeof message === 'string'
          ? ethers.utils.toUtf8Bytes(message)
          : message;
      const messageHash = ethers.utils.hashMessage(messageBytes);

      // Sign raw payload using Turnkey
      const { activity, r, s, v } = await this.client.signRawPayload({
        signWith: this.address,
        payload: messageHash.slice(2), // Remove 0x prefix
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NO_OP',
      });

      // Check that the activity completed
      if (activity.status !== 'ACTIVITY_STATUS_COMPLETED') {
        throw new Error(
          `Message signing activity did not complete. Status: ${activity.status}`,
        );
      }

      // Reconstruct the signature from r, s, v
      return ethers.utils.joinSignature({ r, s, v: parseInt(v, 16) });
    } catch (error) {
      logger.error('Failed to sign message with Turnkey:', error);
      throw error;
    }
  }

  /**
   * Populate a transaction with default values (nonce, gas, etc.)
   */
  async populateTransaction(
    transaction: ethers.providers.TransactionRequest,
  ): Promise<ethers.providers.TransactionRequest> {
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
        tx.maxFeePerGas = feeData.maxFeePerGas;
        tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || undefined;
      } else {
        tx.gasPrice = feeData.gasPrice || undefined;
      }
    }

    // Get chain ID if not set
    if (tx.chainId == null) {
      const network = await this.provider.getNetwork();
      tx.chainId = network.chainId;
    }

    // Estimate gas if not set
    if (tx.gasLimit == null) {
      tx.gasLimit = await this.provider.estimateGas(tx);
    }

    return tx;
  }
}

/**
 * Get Turnkey EVM signer for a specific role
 * Fetches the Turnkey config from GCP Secret Manager and creates a signer
 */
export async function getTurnkeyEvmSigner(
  deployEnvironment: DeployEnvironment,
  role: Exclude<TurnkeyRole, TurnkeyRole.SealevelDeployer>,
): Promise<TurnkeyEvmSigner> {
  return createTurnkeySigner(
    deployEnvironment,
    role,
  ) as Promise<TurnkeyEvmSigner>;
}

export async function setTurnkeySignerForEvmChains(
  multiProvider: MultiProvider,
  deployEnvironment: DeployEnvironment,
  role: Exclude<TurnkeyRole, TurnkeyRole.SealevelDeployer>,
): Promise<void> {
  const turnkeySigner = await getTurnkeyEvmSigner(deployEnvironment, role);
  await Promise.all(
    multiProvider.getKnownChainNames().reduce<Promise<void>[]>((acc, chain) => {
      if (multiProvider.getProtocol(chain) === ProtocolType.Ethereum) {
        acc.push(
          (async () => {
            const provider = multiProvider.getProvider(chain);
            const signer = await turnkeySigner.getSigner(provider);
            multiProvider.setSigner(chain, signer);
          })(),
        );
      }
      return acc;
    }, []),
  );
}

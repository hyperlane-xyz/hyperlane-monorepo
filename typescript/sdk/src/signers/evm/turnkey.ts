import type { TActivity } from '@turnkey/sdk-server';
import { ethers } from 'ethers';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  TurnkeyClientManager,
  TurnkeyConfig,
  logTurnkeyError,
  validateTurnkeyActivityCompleted,
} from '../turnkeyClient.js';

const logger = rootLogger.child({ module: 'sdk:turnkey-evm' });

/**
 * Turnkey's `signRawPayload` returns r/s as bare 32-byte hex (no `0x` prefix).
 * Validate the component is exactly 32 bytes (64 hex chars) after stripping any
 * prefix and return it `0x`-prefixed for ethers.
 */
export function normalizeSignatureComponent(
  label: string,
  value: string,
): string {
  const stripped =
    value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(`Invalid ${label} value from Turnkey`);
  }
  return `0x${stripped}`;
}

/**
 * Lift Turnkey's recovery id into ethers' v space. Turnkey returns v as a hex
 * recovery id ("00"/"01"); ethers v5 `joinSignature` expects 27/28, and
 * misinterprets a bare 0/1. Values already in 27/28 form ("1b"/"1c") pass through
 * unchanged. A non-hex/garbage v throws.
 */
export function normalizeRecoveryV(v: string): number {
  const parsedV = parseInt(v, 16);
  if (isNaN(parsedV)) {
    throw new Error(`Invalid v value from Turnkey: ${v}`);
  }
  // Only a real recovery id is valid: 0/1 (Turnkey's form) → 27/28 (ethers'
  // form), or an already-lifted 27/28. Reject anything else — a bad value
  // would silently yield an unrecoverable signature rather than fail loudly.
  if (parsedV === 0 || parsedV === 1) return parsedV + 27;
  if (parsedV === 27 || parsedV === 28) return parsedV;
  throw new Error(`Unsupported recovery id from Turnkey: ${v}`);
}

/**
 * Turnkey signer for EVM transactions
 * Uses Turnkey's secure enclaves to sign transactions without exposing private keys
 * This is a custom ethers v5-compatible Signer that uses Turnkey SDK directly
 * Uses composition to access Turnkey functionality while extending ethers.Signer
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
 * const provider = new ethers.providers.JsonRpcProvider('...');
 * const signer = new TurnkeyEvmSigner(config, provider);
 *
 * // Use with MultiProvider
 * multiProvider.setSigner('ethereum', signer);
 * ```
 */
export class TurnkeyEvmSigner extends ethers.Signer {
  private readonly manager: TurnkeyClientManager;
  public readonly address: string;
  public readonly provider: ethers.providers.Provider | undefined;

  constructor(config: TurnkeyConfig, provider?: ethers.providers.Provider) {
    super();
    this.manager = new TurnkeyClientManager(config);
    this.address = config.publicKey;
    this.provider = provider;

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
  async getSigner(provider: ethers.providers.Provider): Promise<ethers.Signer> {
    logger.debug('Creating Turnkey EVM signer for transaction');
    return this.connect(provider);
  }

  /**
   * Connect this signer to a provider (creates new instance with proper configuration)
   */
  connect(provider: ethers.providers.Provider): TurnkeyEvmSigner {
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
      const { from: _, ...txToSerialize } = populatedTx;

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
      const { activity } = await this.manager.getClient().signTransaction({
        signWith: this.address,
        type: 'TRANSACTION_TYPE_ETHEREUM',
        unsignedTransaction: unsignedTxHex,
      });

      validateTurnkeyActivityCompleted(activity, 'Transaction signing');

      const signedTx =
        activity.result?.signTransactionResult?.signedTransaction;
      if (!signedTx) {
        throw new Error('No signed transaction returned from Turnkey');
      }

      logger.debug('Transaction signed successfully');
      // Ensure the signed transaction has 0x prefix
      return signedTx.startsWith('0x') ? signedTx : `0x${signedTx}`;
    } catch (error) {
      logTurnkeyError('Failed to sign transaction with Turnkey', error);
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

      const { activity, r, s, v } = await this.manager
        .getClient()
        .signRawPayload({
          signWith: this.address,
          payload: messageHash.slice(2), // Remove 0x prefix
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NO_OP',
        });

      return this.assembleSignature(activity, r, s, v, 'Message signing');
    } catch (error) {
      logTurnkeyError('Failed to sign message with Turnkey', error);
      throw error;
    }
  }

  /**
   * EIP-712 typed-data signing per the ethers v5 Signer interface.
   *
   * Submits the full typed-data payload to Turnkey using
   * `PAYLOAD_ENCODING_EIP712` (rather than hashing locally and submitting an
   * opaque digest) so Turnkey policies can inspect the domain and message
   * fields — e.g. a Safe proposal's `to`/`value`/`data`/`operation`/`nonce` —
   * before authorizing the signature. Returns the canonical joined ECDSA
   * signature that downstream consumers like Safe Transaction Service expect
   * for typed-data sender signatures.
   */
  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    logger.debug('Signing typed data with Turnkey');

    try {
      // Resolve ENS names in address-typed fields via the provider, mirroring
      // ethers v5's own Wallet._signTypedData, before encoding the payload.
      const populated = await ethers.utils._TypedDataEncoder.resolveNames(
        domain,
        types,
        value,
        (name: string) => {
          if (this.provider == null) {
            return Promise.reject(
              new Error(`Cannot resolve ENS name "${name}" without a provider`),
            );
          }
          return this.provider.resolveName(name).then((address) => {
            if (address == null) {
              throw new Error(`Unconfigured ENS name "${name}"`);
            }
            return address;
          });
        },
      );

      // Produce the standard EIP-712 JSON payload (types incl. EIP712Domain,
      // primaryType, domain, message) that Turnkey decodes for policy checks.
      const payload = ethers.utils._TypedDataEncoder.getPayload(
        populated.domain,
        types,
        populated.value,
      );

      const { activity, r, s, v } = await this.manager
        .getClient()
        .signRawPayload({
          signWith: this.address,
          payload: JSON.stringify(payload),
          encoding: 'PAYLOAD_ENCODING_EIP712',
          hashFunction: 'HASH_FUNCTION_NO_OP',
        });

      return this.assembleSignature(activity, r, s, v, 'Typed-data signing');
    } catch (error) {
      logTurnkeyError('Failed to sign typed data with Turnkey', error);
      throw error;
    }
  }

  /**
   * Validate the Turnkey activity completed, ensure r/s/v are well-formed,
   * and join them into ethers' canonical `0x{r}{s}{v}` ECDSA signature.
   */
  private assembleSignature(
    activity: TActivity,
    r: string | undefined,
    s: string | undefined,
    v: string | undefined,
    operationType: string,
  ): string {
    validateTurnkeyActivityCompleted(activity, operationType);

    if (!r || !s || !v) {
      throw new Error('Missing signature components from Turnkey');
    }

    // Turnkey returns r/s as bare hex and v as a recovery id ("00"/"01"). Re-add
    // the 0x prefix and lift the recovery id into ethers' 27/28 v space: ethers
    // v5 `joinSignature` misinterprets a bare 0/1 as the wrong recoveryParam.
    const rHex = normalizeSignatureComponent('r', r);
    const sHex = normalizeSignatureComponent('s', s);
    const recoveryV = normalizeRecoveryV(v);

    return ethers.utils.joinSignature({ r: rHex, s: sHex, v: recoveryV });
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

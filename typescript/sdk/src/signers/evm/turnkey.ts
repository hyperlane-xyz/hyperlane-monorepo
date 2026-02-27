import {
  AbstractSigner,
  Provider,
  Signature,
  Transaction,
  TransactionRequest,
  getBytes,
  hashMessage,
  resolveProperties,
  toUtf8Bytes,
} from 'ethers';
import type { Signer, TypedDataDomain, TypedDataField } from 'ethers';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  TurnkeyClientManager,
  TurnkeyConfig,
  logTurnkeyError,
  validateTurnkeyActivityCompleted,
} from '../turnkeyClient.js';

const logger = rootLogger.child({ module: 'sdk:turnkey-evm' });

export class TurnkeyEvmSigner extends AbstractSigner {
  private readonly manager: TurnkeyClientManager;
  public readonly address: string;

  constructor(config: TurnkeyConfig, provider?: Provider | null) {
    super(provider ?? null);
    this.manager = new TurnkeyClientManager(config);
    this.address = config.publicKey;

    logger.debug(`Initialized Turnkey EVM signer for key: ${this.address}`);
  }

  async healthCheck(): Promise<boolean> {
    return this.manager.healthCheck();
  }

  async getSigner(provider: Provider): Promise<Signer> {
    logger.debug('Creating Turnkey EVM signer for transaction');
    return this.connect(provider);
  }

  connect(provider: Provider | null): TurnkeyEvmSigner {
    return new TurnkeyEvmSigner(this.manager.getConfig(), provider);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async signTransaction(transaction: TransactionRequest): Promise<string> {
    if (!this.provider) {
      throw new Error('Provider required to sign transaction');
    }

    logger.debug('Signing transaction with Turnkey', {
      to: transaction.to,
      value: transaction.value?.toString(),
    });

    try {
      const populatedTx = await resolveProperties(
        await super.populateTransaction(transaction),
      );
      const { from: _, ...txToSerialize } = populatedTx;

      if (txToSerialize.maxFeePerGas || txToSerialize.maxPriorityFeePerGas) {
        txToSerialize.type = 2;
        delete txToSerialize.gasPrice;
      }

      const unsignedTx = Transaction.from({
        ...txToSerialize,
        to: txToSerialize.to ? String(txToSerialize.to) : undefined,
      } as any).unsignedSerialized;
      const unsignedTxHex = unsignedTx.startsWith('0x')
        ? unsignedTx.slice(2)
        : unsignedTx;

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
      return signedTx.startsWith('0x') ? signedTx : `0x${signedTx}`;
    } catch (error) {
      logTurnkeyError('Failed to sign transaction with Turnkey', error);
      throw error;
    }
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    logger.debug('Signing message with Turnkey');

    try {
      const messageBytes =
        typeof message === 'string' ? toUtf8Bytes(message) : getBytes(message);
      const messageHash = hashMessage(messageBytes);

      const { activity, r, s, v } = await this.manager
        .getClient()
        .signRawPayload({
          signWith: this.address,
          payload: messageHash.slice(2),
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NO_OP',
        });

      validateTurnkeyActivityCompleted(activity, 'Message signing');

      if (!r || !s || !v) {
        throw new Error('Missing signature components from Turnkey');
      }

      const hexPattern = /^0x[0-9a-fA-F]+$/;
      if (!hexPattern.test(r) || !hexPattern.test(s)) {
        throw new Error('Invalid signature format from Turnkey');
      }

      const vNum = parseInt(v, 16);
      if (isNaN(vNum)) {
        throw new Error(`Invalid v value from Turnkey: ${v}`);
      }

      return Signature.from({ r, s, v: vNum }).serialized;
    } catch (error) {
      logTurnkeyError('Failed to sign message with Turnkey', error);
      throw error;
    }
  }

  async signTypedData(
    _domain: TypedDataDomain,
    _types: Record<string, Array<TypedDataField>>,
    _value: Record<string, any>,
  ): Promise<string> {
    throw new Error('signTypedData is not implemented for TurnkeyEvmSigner');
  }
}

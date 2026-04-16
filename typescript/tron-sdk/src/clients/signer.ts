import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { TronReceipt, TronTransaction } from '../utils/types.js';

import { TronProvider } from './provider.js';

export class TronSigner
  extends TronProvider
  implements AltVM.ISigner<TronTransaction, TronReceipt>
{
  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ): Promise<TronSigner> {
    assert(extraParams, `extra params not defined`);

    const metadata = extraParams.metadata as Record<string, unknown>;
    assert(metadata, `metadata not defined in extra params`);

    return new TronSigner(rpcUrls, privateKey);
  }

  protected constructor(rpcUrls: string[], privateKey: string) {
    super(rpcUrls, privateKey);
  }

  getSignerAddress(): string {
    return this.tronweb.defaultAddress.base58 || '';
  }

  getTronweb(): TronWeb {
    return this.tronweb;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: TronTransaction,
  ): Promise<object> {
    return transaction;
  }

  async sendAndConfirmTransaction(
    transaction: TronTransaction,
  ): Promise<TronReceipt> {
    const signedTx = await this.tronweb.trx.sign(transaction);
    const result = await this.tronweb.trx.sendRawTransaction(signedTx);

    if (!result?.result || !result.txid) {
      throw new Error(
        `Failed to broadcast transaction: ${result.code ?? result.message ?? 'unknown error'}`,
      );
    }

    const receipt = await this.waitForTransaction(result.txid);

    return receipt;
  }

  async sendAndConfirmBatchTransactions(
    _transactions: TronTransaction[],
  ): Promise<TronReceipt> {
    throw new Error(`${TronSigner.name} does not support transaction batching`);
  }
}

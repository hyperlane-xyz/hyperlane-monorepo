import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { assert } from '@hyperlane-xyz/utils';

import { TronReceipt, TronTransaction } from '../utils/types.js';

import { TronProvider } from './provider.js';

export class TronSigner
  extends TronProvider
  implements AltVM.ISigner<TronTransaction, TronReceipt>
{
  static async connectWithSigner(
    metadata: ChainMetadataForAltVM,
    privateKey: string,
  ): Promise<TronSigner> {
    const rpcUrls = (metadata.rpcUrls ?? []).map((rpc) => rpc.http);
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    return new TronSigner(rpcUrls, metadata, privateKey);
  }

  protected constructor(
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
    privateKey: string,
  ) {
    super(rpcUrls, chainMetadata, privateKey);
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

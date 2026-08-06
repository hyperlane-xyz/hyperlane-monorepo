import {
  type TransactionSigner,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import {
  convertLegacySolanaTransaction,
  isLegacySolanaTransaction,
} from '../legacy-compat.js';
import { createRpc } from '../rpc.js';
import type {
  AnnotatedSvmTransaction,
  SvmReceipt,
  SvmRpc,
  SvmTransaction,
  WithExtraSigners,
} from '../types.js';

import { SvmProvider } from './provider.js';
import {
  type PrintableSvmTransaction,
  type SendableSvmTransaction,
  buildPrintableTransaction,
  createKeypairFromPrivateKey,
  fetchTransactionMeta,
  sendWithConfirmation,
} from './tx-submission.js';

export type {
  PrintableSvmInstruction,
  PrintableSvmTransaction,
} from './tx-submission.js';

export class SvmSigner
  extends SvmProvider
  implements AltVM.ISigner<SvmTransaction, SvmReceipt>
{
  readonly signer: TransactionSigner;
  private readonly logger = rootLogger.child({ module: 'SvmSigner' });

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
    signer: TransactionSigner,
  ) {
    super(rpc, rpcUrls, chainMetadata);
    this.signer = signer;
  }

  static async connectWithSigner(
    metadata: ChainMetadataForAltVM,
    privateKey: string,
  ): Promise<SvmSigner> {
    const rpcUrls = (metadata.rpcUrls ?? []).map((rpc) => rpc.http);
    assert(rpcUrls.length > 0, 'At least one RPC URL is required');
    const rpc = createRpc(rpcUrls[0]);
    const keypair = await createKeypairFromPrivateKey(privateKey);

    return new SvmSigner(rpc, rpcUrls, metadata, keypair);
  }

  getSignerAddress(): string {
    return this.signer.address;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: AnnotatedSvmTransaction,
  ): Promise<PrintableSvmTransaction> {
    return buildPrintableTransaction(
      this.rpc,
      this.signer.address,
      transaction,
    );
  }

  async send(tx: SendableSvmTransaction): Promise<SvmReceipt> {
    return sendWithConfirmation({
      rpc: this.rpc,
      feePayer: this.signer,
      tx,
      logger: this.logger,
      signMessage: signTransactionMessageWithSigners,
    });
  }

  async sendAndConfirmTransaction(
    transaction: WithExtraSigners<SendableSvmTransaction>,
  ): Promise<SvmReceipt> {
    const tx = isLegacySolanaTransaction(transaction)
      ? await convertLegacySolanaTransaction(
          transaction,
          transaction.extraSigners,
        )
      : transaction;

    const receipt = await this.send(tx);
    return fetchTransactionMeta(this.rpc, this.logger, receipt);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: SendableSvmTransaction[],
  ): Promise<SvmReceipt> {
    throw new Error('Sealevel does not support transaction batching');
  }
}

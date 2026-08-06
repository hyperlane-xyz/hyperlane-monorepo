import {
  type TransactionSigner,
  partiallySignTransactionMessageWithSigners,
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

/**
 * A signer that partially signs transactions with only the held fee payer and
 * leaves every other required signature slot empty, then submits. The empty
 * slots are rejected by ordinary validators but accepted by a fork running
 * with skip-signature-verification — the Sealevel analog of impersonating an
 * account on an anvil fork. It never signs on behalf of the accounts it
 * impersonates, so it must only ever target a fork, never a live cluster.
 */
export class SvmImpersonatingSigner
  extends SvmProvider
  implements AltVM.ISigner<SvmTransaction, SvmReceipt>
{
  readonly signer: TransactionSigner;
  private readonly logger = rootLogger.child({
    module: 'SvmImpersonatingSigner',
  });

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
  ): Promise<SvmImpersonatingSigner> {
    const rpcUrls = (metadata.rpcUrls ?? []).map((rpc) => rpc.http);
    assert(rpcUrls.length > 0, 'At least one RPC URL is required');
    const rpc = createRpc(rpcUrls[0]);
    const keypair = await createKeypairFromPrivateKey(privateKey);

    return new SvmImpersonatingSigner(rpc, rpcUrls, metadata, keypair);
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
      signMessage: partiallySignTransactionMessageWithSigners,
      // Preflight simulation verifies signatures; the impersonated slots are
      // empty, so it would reject a transaction the fork itself accepts.
      skipPreflight: true,
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

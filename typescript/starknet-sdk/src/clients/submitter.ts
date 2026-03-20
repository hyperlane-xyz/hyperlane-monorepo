import {
  type AltVM,
  type ITransactionSubmitter,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { type Logger, rootLogger } from '@hyperlane-xyz/utils';

export class StarknetJsonRpcSubmitter implements ITransactionSubmitter {
  protected readonly logger: Logger = rootLogger.child({
    module: StarknetJsonRpcSubmitter.name,
  });

  constructor(
    private readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
    private readonly config: { chain: string },
  ) {}

  async submit(...txs: AnnotatedTx[]): Promise<TxReceipt[]> {
    if (txs.length === 0) return [];

    const canBatch =
      this.signer.supportsTransactionBatching() &&
      txs.every((tx) => tx['kind'] !== 'deploy');

    if (canBatch) {
      for (const tx of txs) {
        if (tx.annotation) this.logger.debug(tx.annotation);
      }
      const receipt = await this.signer.sendAndConfirmBatchTransactions(txs);
      return [receipt];
    }

    const receipts: TxReceipt[] = [];
    for (const tx of txs) {
      if (tx.annotation) this.logger.debug(tx.annotation);
      receipts.push(await this.signer.sendAndConfirmTransaction(tx));
    }

    this.logger.debug(
      `Submitted ${receipts.length} txs on ${this.config.chain}`,
    );
    return receipts;
  }
}

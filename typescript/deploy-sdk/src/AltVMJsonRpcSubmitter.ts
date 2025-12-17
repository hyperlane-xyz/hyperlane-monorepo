import {
  type AltVM,
  type ITransactionSubmitter,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { type Logger, rootLogger } from '@hyperlane-xyz/utils';

export class AltVMJsonRpcSubmitter implements ITransactionSubmitter {
  public readonly txSubmitterType = 'jsonRPC';

  protected readonly logger: Logger = rootLogger.child({
    module: 'AltVMJsonRpcSubmitter',
  });

  constructor(
    public readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
    public readonly config: { chain: string },
  ) {
    this.logger = rootLogger.child({
      module: AltVMJsonRpcSubmitter.name,
    });
  }

  public async submit(...txs: AnnotatedTx[]): Promise<TxReceipt[]> {
    if (txs.length === 0) {
      return [];
    }

    if (this.signer.supportsTransactionBatching()) {
      for (const tx of txs) {
        if (tx.annotation) {
          this.logger.debug(tx.annotation);
        }
      }
      const receipt = await this.signer.sendAndConfirmBatchTransactions(txs);
      return [receipt];
    }

    const receipts: TxReceipt[] = [];

    for (const tx of txs) {
      if (tx.annotation) {
        this.logger.debug(tx.annotation);
      }

      const receipt = await this.signer.sendAndConfirmTransaction(tx);
      receipts.push(receipt);
    }

    return receipts;
  }
}

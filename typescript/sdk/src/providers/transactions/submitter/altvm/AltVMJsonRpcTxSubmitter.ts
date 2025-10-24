import { Logger } from 'pino';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  AnnotatedTypedTransaction,
  ProtocolReceipt,
  ProtocolTransaction,
} from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class AltVMJsonRpcTxSubmitter<PT extends ProtocolType>
  implements TxSubmitterInterface<PT>
{
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger;

  constructor(
    public readonly signer: AltVM.ISigner<
      ProtocolTransaction<PT>,
      ProtocolReceipt<PT>
    >,
    public readonly config: { chain: string },
  ) {
    this.logger = rootLogger.child({
      module: AltVMJsonRpcTxSubmitter.name,
    });
  }

  public async submit(
    ...txs: AnnotatedTypedTransaction<PT>[]
  ): Promise<ProtocolReceipt<PT>[]> {
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

    const receipts = [];

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

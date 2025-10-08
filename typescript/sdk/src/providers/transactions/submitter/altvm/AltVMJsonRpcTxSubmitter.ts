import { Logger } from 'pino';

import { AltVM, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import {
  AnnotatedTypedTransaction,
  ProtocolReceipt,
  ProtocolTransaction,
} from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class AltVMJsonRpcTxSubmitter<PT extends ProtocolType>
  implements TxSubmitterInterface<any>
{
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  private signer: AltVM.ISigner<ProtocolTransaction<PT>, ProtocolReceipt<PT>>;

  protected readonly logger: Logger;

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly altVmSigner: AltVM.ISignerFactory<
      ProtocolTransaction<PT>,
      ProtocolReceipt<PT>
    >,
    public readonly config: { chain: string },
  ) {
    this.signer = this.altVmSigner.get(this.config.chain);

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

import { Logger } from 'pino';

import { AltVM, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedAltVMTransaction } from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class AltVMJsonRpcTxSubmitter implements TxSubmitterInterface<any> {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  private signer: AltVM.ISigner;

  protected readonly logger: Logger = rootLogger.child({
    module: AltVMJsonRpcTxSubmitter.name,
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly altVmSigner: AltVM.ISignerFactory,
    public readonly config: { chain: string },
  ) {
    this.signer = this.altVmSigner.get(this.config.chain);
  }

  public async submit(...txs: AnnotatedAltVMTransaction[]): Promise<any[]> {
    if (txs.length === 0) {
      return [];
    }

    for (const tx of txs) {
      if (tx.annotation) {
        this.logger.debug(tx.annotation);
      }
    }

    if (this.signer.supportsMultiTransactions()) {
      const receipt = await this.signer.sendAndConfirmMultiTransactions(
        txs.map((tx) => tx.altvm_tx),
      );
      return [receipt];
    }

    const receipts = [];

    for (const tx of txs) {
      const receipt = await this.signer.sendAndConfirmTransaction(tx.altvm_tx);
      receipts.push(receipt);
    }

    return receipts;
  }
}

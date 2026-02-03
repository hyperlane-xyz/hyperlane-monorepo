import {
  AltVM,
  FileSubmitterConfig,
  ITransactionSubmitter,
} from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';
import { readYamlOrJson, writeYamlOrJson } from '@hyperlane-xyz/utils/fs';

export class AltVMFileSubmitter implements ITransactionSubmitter {
  public readonly txSubmitterType = 'file';

  protected readonly logger: Logger = rootLogger.child({
    module: 'AltVMFileSubmitter',
  });

  constructor(
    public readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
    public readonly props: FileSubmitterConfig,
  ) {}

  async submit(...txs: AnnotatedTx[]): Promise<TxReceipt[]> {
    const filepath = this.props.filepath.trim();
    const allTxs = [];

    // Convert raw transactions to printable ones which can later be signed
    for (const tx of txs) {
      allTxs.push(await this.signer.transactionToPrintableJson(tx));
    }

    // Attempt to append transactions to existing filepath.
    const maybeExistingTxs = readYamlOrJson(filepath);
    if (maybeExistingTxs !== null) {
      if (!Array.isArray(maybeExistingTxs)) {
        this.logger.debug(
          `Target filepath ${filepath} has existing data, but is not an array. Overwriting.`,
        );
      } else {
        allTxs.unshift(...maybeExistingTxs);
      }
    }

    writeYamlOrJson(filepath, allTxs);
    this.logger.debug(`Transactions written to ${filepath}`);
    return [];
  }
}

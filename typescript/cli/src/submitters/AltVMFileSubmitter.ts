import { Logger } from 'pino';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  ProtocolReceipt,
  ProtocolTransaction,
  ProtocolTypedTransaction,
  TxSubmitterInterface,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { Annotated, assert, rootLogger } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { CustomTxSubmitterType, FileTxSubmitterProps } from './types.js';

export class AltVMFileSubmitter<PT extends ProtocolType>
  implements TxSubmitterInterface<PT>
{
  txSubmitterType: TxSubmitterType =
    CustomTxSubmitterType.FILE as TxSubmitterType;

  protected readonly logger: Logger;

  constructor(
    public readonly signer: AltVM.ISigner<
      ProtocolTransaction<PT>,
      ProtocolReceipt<PT>
    >,
    public readonly props: FileTxSubmitterProps,
  ) {
    this.logger = rootLogger.child({
      module: AltVMFileSubmitter.name,
    });
  }

  async submit(
    ...txs: Annotated<ProtocolTypedTransaction<PT>['transaction']>[]
  ): Promise<[]> {
    const filepath = this.props.filepath.trim();
    const allTxs = [];

    // Convert raw transactions to printable ones which can later be signed
    for (const tx of txs) {
      allTxs.push(await this.signer.transactionToPrintableJson(tx));
    }

    // Attempt to append transactions to existing filepath.
    try {
      const maybeExistingTxs = readYamlOrJson(filepath); // Can throw if file is empty
      assert(
        Array.isArray(maybeExistingTxs),
        `Target filepath ${filepath} has existing data, but is not an array. Overwriting.`,
      );
      allTxs.unshift(...maybeExistingTxs);
    } catch (e) {
      this.logger.debug(`Invalid transactions read from ${filepath}: ${e}`);
    }

    writeYamlOrJson(filepath, allTxs);
    this.logger.debug(`Transactions written to ${filepath}`);
    return [];
  }
}

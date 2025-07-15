import { Logger } from 'pino';

import {
  ProtocolTypedTransaction,
  TxSubmitterInterface,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { Annotated, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { appendYamlOrJson } from '../utils/files.js';

import { CustomTxSubmitterType, EV5FileTxSubmitterProps } from './types.js';

export class EV5FileSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  txSubmitterType: TxSubmitterType =
    CustomTxSubmitterType.FILE as TxSubmitterType;
  protected readonly logger: Logger = rootLogger.child({
    module: 'file-submitter',
  });
  constructor(public readonly props: EV5FileTxSubmitterProps) {}

  async submit(
    ...txs: Annotated<
      ProtocolTypedTransaction<ProtocolType.Ethereum>['transaction']
    >[]
  ): Promise<[]> {
    // Appends all transactions to a single file
    const filepath = this.props.filepath.trim();
    appendYamlOrJson(filepath, txs);

    this.logger.debug(`Transactions written to ${filepath}`);
    return [];
  }
}

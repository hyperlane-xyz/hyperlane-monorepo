// eslint-disable-next-line
import fs from 'fs';
// eslint-disable-next-line
import path from 'path';
import { Logger } from 'pino';

import { Annotated, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { ProtocolTypedTransaction } from '../../providers/ProviderType.js';
import { TxSubmitterInterface } from '../../providers/transactions/submitter/TxSubmitterInterface.js';
import { TxSubmitterType } from '../../providers/transactions/submitter/TxSubmitterTypes.js';
import { EV5FileTxSubmitterProps } from '../../providers/transactions/submitter/ethersV5/types.js';

export class EV5FileSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  txSubmitterType: TxSubmitterType = TxSubmitterType.FILE;
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
    const dirPath = path.dirname(filepath);
    if (!fs.existsSync(dirPath))
      fs.mkdirSync(dirPath, {
        recursive: true,
      });
    fs.appendFileSync(filepath, JSON.stringify(txs, null, 2));

    this.logger.debug(`Transactions written to ${filepath}`);
    return [];
  }
}

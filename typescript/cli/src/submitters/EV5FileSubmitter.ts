import fs from 'fs';
import path from 'path';
import { Logger } from 'pino';
import { z } from 'zod';

import { TxSubmitterInterface, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { Annotated, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

export const EV5FileTxSubmitterPropsSchema = z.object({
  filepath: z.string(),
});

export type EV5FileTxSubmitterProps = z.infer<
  typeof EV5FileTxSubmitterPropsSchema
>;

export class EV5FileSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  txSubmitterType: TxSubmitterType = 'file' as TxSubmitterType;
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

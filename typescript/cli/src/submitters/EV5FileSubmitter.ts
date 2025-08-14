import { Logger } from 'pino';

import {
  ProtocolTypedTransaction,
  TxSubmitterInterface,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import {
  Annotated,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

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
    const filepath = this.props.filepath.trim();
    const allTxs = [...txs];

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

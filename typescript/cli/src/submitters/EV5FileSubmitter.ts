import { type Logger } from 'pino';

import {
  type ProtocolTypedTransaction,
  type TxSubmitterInterface,
  type TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import {
  type Annotated,
  type ProtocolType,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { CustomTxSubmitterType, type FileTxSubmitterProps } from './types.js';

const fileWriteQueue = new Map<string, Promise<void>>();

async function withFileLock<T>(
  filepath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = fileWriteQueue.get(filepath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => next);
  fileWriteQueue.set(filepath, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (fileWriteQueue.get(filepath) === queued) {
      fileWriteQueue.delete(filepath);
    }
  }
}

export class EV5FileSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  txSubmitterType: TxSubmitterType =
    CustomTxSubmitterType.FILE as TxSubmitterType;
  protected readonly logger: Logger = rootLogger.child({
    module: 'file-submitter',
  });
  constructor(public readonly props: FileTxSubmitterProps) {}

  async submit(
    ...txs: Annotated<
      ProtocolTypedTransaction<ProtocolType.Ethereum>['transaction']
    >[]
  ): Promise<[]> {
    const filepath = this.props.filepath.trim();
    await withFileLock(filepath, async () => {
      const allTxs = [...txs];

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
    });
    return [];
  }
}

import { type Logger } from 'pino';

import {
  type ProtocolTypedTransaction,
  type TxSubmitterInterface,
  type TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import {
  type Annotated,
  type ProtocolType,
  assert,
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
  fileWriteQueue.set(
    filepath,
    previous.then(() => next),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (fileWriteQueue.get(filepath) === next) {
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
    });
    return [];
  }
}

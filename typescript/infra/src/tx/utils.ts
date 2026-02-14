import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { rootLogger, stringifyObject } from '@hyperlane-xyz/utils';
import { writeYaml } from '@hyperlane-xyz/utils/fs';

import { GovernTransaction } from './govern-transaction-reader.js';

type ConfirmPrompt = (options: {
  message: string;
  default: boolean;
}) => Promise<unknown>;
type ProcessGovernorReaderResultDeps = {
  writeYamlFn?: typeof writeYaml;
  nowFn?: () => number;
  exitFn?: (code: number) => never | void;
};

function stringifyValueForError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

export function processGovernorReaderResult(
  result: [string, GovernTransaction][],
  errors: any[],
  outputFileName: string,
  deps: ProcessGovernorReaderResultDeps = {},
) {
  if (!Array.isArray(result)) {
    throw new Error(
      `Governor reader result must be an array: ${stringifyValueForError(result)}`,
    );
  }
  if (!Array.isArray(errors)) {
    throw new Error(
      `Governor reader errors must be an array: ${stringifyValueForError(errors)}`,
    );
  }
  if (
    typeof outputFileName !== 'string' ||
    outputFileName.trim().length === 0
  ) {
    throw new Error(
      `Governor reader output file name must be a non-empty string: ${stringifyValueForError(outputFileName)}`,
    );
  }
  const normalizedOutputFileName = outputFileName.trim();
  if (
    deps.writeYamlFn !== undefined &&
    typeof deps.writeYamlFn !== 'function'
  ) {
    throw new Error(
      `Governor reader writeYamlFn must be a function: ${stringifyValueForError(deps.writeYamlFn)}`,
    );
  }
  if (deps.nowFn !== undefined && typeof deps.nowFn !== 'function') {
    throw new Error(
      `Governor reader nowFn must be a function: ${stringifyValueForError(deps.nowFn)}`,
    );
  }
  if (deps.exitFn !== undefined && typeof deps.exitFn !== 'function') {
    throw new Error(
      `Governor reader exitFn must be a function: ${stringifyValueForError(deps.exitFn)}`,
    );
  }
  const writeYamlFn = deps.writeYamlFn ?? writeYaml;
  const nowFn = deps.nowFn ?? Date.now;
  const exitFn = deps.exitFn ?? process.exit;

  if (errors.length) {
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
    rootLogger.info(stringifyObject(errors, 'yaml', 2));
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
  } else {
    rootLogger.info(chalk.green('✅✅✅✅✅ No fatal errors ✅✅✅✅✅'));
  }

  const chainResults = Object.fromEntries(result);
  const resultsPath = `${normalizedOutputFileName}-${nowFn()}.yaml`;
  writeYamlFn(resultsPath, chainResults);
  rootLogger.info(`Results written to ${resultsPath}`);

  if (errors.length) {
    exitFn(1);
  }
}

export async function executePendingTransactions<T>(
  executableTxs: T[],
  txId: (tx: T) => string,
  txChain: (tx: T) => string,
  executeTx: (tx: T) => Promise<any>,
  confirmPrompt: ConfirmPrompt = (options) => confirm(options),
) {
  if (!Array.isArray(executableTxs)) {
    throw new Error(
      `Executable transactions must be an array: ${stringifyValueForError(executableTxs)}`,
    );
  }
  if (typeof txId !== 'function') {
    throw new Error(`txId must be a function: ${stringifyValueForError(txId)}`);
  }
  if (typeof txChain !== 'function') {
    throw new Error(
      `txChain must be a function: ${stringifyValueForError(txChain)}`,
    );
  }
  if (typeof executeTx !== 'function') {
    throw new Error(
      `executeTx must be a function: ${stringifyValueForError(executeTx)}`,
    );
  }
  if (typeof confirmPrompt !== 'function') {
    throw new Error(
      `confirmPrompt must be a function: ${stringifyValueForError(confirmPrompt)}`,
    );
  }

  let executableTxCount = 0;
  try {
    executableTxCount = executableTxs.length;
  } catch {
    throw new Error('Executable transactions length is inaccessible');
  }
  if (!Number.isSafeInteger(executableTxCount) || executableTxCount < 0) {
    throw new Error(
      `Executable transactions length is invalid: ${stringifyValueForError(executableTxCount)}`,
    );
  }

  if (executableTxCount === 0) {
    return;
  }

  // Ask if user wants to execute all transactions at once
  let confirmExecuteAll = false;
  try {
    const executeAllResponse = await confirmPrompt({
      message: `Execute ALL ${executableTxCount} transactions without further prompts?`,
      default: false,
    });
    if (typeof executeAllResponse === 'boolean') {
      confirmExecuteAll = executeAllResponse;
    } else {
      rootLogger.error(
        chalk.red(
          `Execute-all confirmation must return boolean, got ${stringifyValueForError(executeAllResponse)}`,
        ),
      );
    }
  } catch (error) {
    rootLogger.error(
      chalk.red('Error prompting for execute-all confirmation:'),
      error,
    );
  }

  const failedTransactions: Array<{
    id: string;
    chain: string;
    error: unknown;
  }> = [];

  for (let index = 0; index < executableTxCount; index += 1) {
    let tx: T;
    try {
      tx = executableTxs[index] as T;
    } catch (error) {
      rootLogger.error(
        chalk.red(`Error reading pending transaction at index ${index}:`),
        error,
      );
      failedTransactions.push({
        id: '<unknown>',
        chain: '<unknown>',
        error,
      });
      continue;
    }
    let id: string;
    let chain: string;
    try {
      id = txId(tx);
      chain = txChain(tx);
    } catch (error) {
      rootLogger.error(
        chalk.red('Error deriving pending transaction metadata:'),
        error,
      );
      failedTransactions.push({
        id: '<unknown>',
        chain: '<unknown>',
        error,
      });
      continue;
    }
    const normalizedId = typeof id === 'string' ? id.trim() : undefined;
    const normalizedChain =
      typeof chain === 'string' ? chain.trim() : undefined;
    if (!normalizedId || !normalizedChain) {
      rootLogger.error(
        chalk.red(
          `Invalid pending transaction metadata: chain=${stringifyValueForError(chain)} id=${stringifyValueForError(id)}`,
        ),
      );
      failedTransactions.push({
        id: normalizedId || '<unknown>',
        chain: normalizedChain || '<unknown>',
        error: new Error('Invalid pending transaction metadata'),
      });
      continue;
    }

    let confirmExecuteTx = confirmExecuteAll;
    if (!confirmExecuteAll) {
      try {
        const executeTxResponse = await confirmPrompt({
          message: `Execute transaction ${normalizedId} on chain ${normalizedChain}?`,
          default: false,
        });
        if (typeof executeTxResponse !== 'boolean') {
          throw new Error(
            `Transaction confirmation must return boolean, got ${stringifyValueForError(executeTxResponse)}`,
          );
        }
        confirmExecuteTx = executeTxResponse;
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Error prompting for transaction ${normalizedId} on chain ${normalizedChain}:`,
          ),
          error,
        );
        failedTransactions.push({
          id: normalizedId,
          chain: normalizedChain,
          error,
        });
        continue;
      }
    }

    if (!confirmExecuteTx) {
      continue;
    }

    rootLogger.info(
      `Executing transaction ${normalizedId} on chain ${normalizedChain}`,
    );
    try {
      await executeTx(tx);
    } catch (error) {
      rootLogger.error(
        chalk.red(
          `Error executing transaction ${normalizedId} on chain ${normalizedChain}:`,
        ),
        error,
      );
      failedTransactions.push({
        id: normalizedId,
        chain: normalizedChain,
        error,
      });
      continue;
    }
  }

  if (failedTransactions.length > 0) {
    const failedTxSummary = failedTransactions
      .map(({ id, chain }) => `${chain}:${id}`)
      .join(', ');
    throw new Error(
      `Failed to execute ${failedTransactions.length} transaction(s): ${failedTxSummary}`,
    );
  }
}

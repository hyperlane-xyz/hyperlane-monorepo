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

function safeErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const errorText = stringifyValueForError(error);
  return errorText.replace(/^[A-Za-z]*Error:\s*/, '');
}

function parseNonNegativeSafeLength(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} is invalid: ${stringifyValueForError(value)}`);
  }
  return value as number;
}

export function processGovernorReaderResult(
  result: [string, GovernTransaction][],
  errors: unknown[],
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
  let resultCount = 0;
  let resultLengthValue: unknown;
  try {
    resultLengthValue = result.length;
  } catch {
    throw new Error('Governor reader result length is inaccessible');
  }
  try {
    resultCount = parseNonNegativeSafeLength(
      resultLengthValue,
      'Governor reader result length',
    );
  } catch (error) {
    throw new Error(
      safeErrorMessage(error) ?? 'Governor reader result length is invalid',
    );
  }
  let errorCount = 0;
  let errorsLengthValue: unknown;
  try {
    errorsLengthValue = errors.length;
  } catch {
    throw new Error('Governor reader errors length is inaccessible');
  }
  try {
    errorCount = parseNonNegativeSafeLength(
      errorsLengthValue,
      'Governor reader errors length',
    );
  } catch (error) {
    throw new Error(
      safeErrorMessage(error) ?? 'Governor reader errors length is invalid',
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
    normalizedOutputFileName.includes('/') ||
    normalizedOutputFileName.includes('\\')
  ) {
    throw new Error(
      `Governor reader output file name must not include path separators: ${normalizedOutputFileName}`,
    );
  }
  if (normalizedOutputFileName === '.' || normalizedOutputFileName === '..') {
    throw new Error(
      `Governor reader output file name must not be '.' or '..': ${normalizedOutputFileName}`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalizedOutputFileName)) {
    throw new Error(
      `Governor reader output file name contains invalid characters: ${normalizedOutputFileName}`,
    );
  }
  if (typeof deps !== 'object' || deps === null) {
    throw new Error(
      `Governor reader deps must be an object: ${stringifyValueForError(deps)}`,
    );
  }
  let writeYamlFnDep: unknown;
  try {
    writeYamlFnDep = (deps as { writeYamlFn?: unknown }).writeYamlFn;
  } catch {
    throw new Error('Governor reader deps.writeYamlFn is inaccessible');
  }
  if (writeYamlFnDep !== undefined && typeof writeYamlFnDep !== 'function') {
    throw new Error(
      `Governor reader writeYamlFn must be a function: ${stringifyValueForError(writeYamlFnDep)}`,
    );
  }
  let nowFnDep: unknown;
  try {
    nowFnDep = (deps as { nowFn?: unknown }).nowFn;
  } catch {
    throw new Error('Governor reader deps.nowFn is inaccessible');
  }
  if (nowFnDep !== undefined && typeof nowFnDep !== 'function') {
    throw new Error(
      `Governor reader nowFn must be a function: ${stringifyValueForError(nowFnDep)}`,
    );
  }
  let exitFnDep: unknown;
  try {
    exitFnDep = (deps as { exitFn?: unknown }).exitFn;
  } catch {
    throw new Error('Governor reader deps.exitFn is inaccessible');
  }
  if (exitFnDep !== undefined && typeof exitFnDep !== 'function') {
    throw new Error(
      `Governor reader exitFn must be a function: ${stringifyValueForError(exitFnDep)}`,
    );
  }
  const writeYamlFn =
    (writeYamlFnDep as typeof writeYaml | undefined) ?? writeYaml;
  const nowFn = (nowFnDep as (() => number) | undefined) ?? Date.now;
  const exitFn =
    (exitFnDep as ((code: number) => never | void) | undefined) ?? process.exit;

  if (errorCount > 0) {
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
    try {
      rootLogger.info(stringifyObject(errors, 'yaml', 2));
    } catch {
      rootLogger.info('<unstringifiable governor reader errors>');
    }
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
  } else {
    rootLogger.info(chalk.green('✅✅✅✅✅ No fatal errors ✅✅✅✅✅'));
  }

  const chainResults = new Map<string, GovernTransaction>();
  for (let index = 0; index < resultCount; index += 1) {
    let resultEntry: [string, GovernTransaction];
    try {
      resultEntry = result[index] as [string, GovernTransaction];
    } catch {
      throw new Error(
        `Governor reader result entry at index ${index} is inaccessible`,
      );
    }
    if (!Array.isArray(resultEntry)) {
      throw new Error(
        `Governor reader result entry at index ${index} must be a tuple`,
      );
    }
    let entryLength = 0;
    let entryLengthValue: unknown;
    try {
      entryLengthValue = resultEntry.length;
    } catch {
      throw new Error(
        `Governor reader result entry length at index ${index} is inaccessible`,
      );
    }
    try {
      entryLength = parseNonNegativeSafeLength(
        entryLengthValue,
        `Governor reader result entry length at index ${index}`,
      );
    } catch (error) {
      throw new Error(
        safeErrorMessage(error) ??
          `Governor reader result entry length at index ${index} is invalid`,
      );
    }
    if (entryLength !== 2) {
      throw new Error(
        `Governor reader result entry at index ${index} must include exactly key and transaction`,
      );
    }
    let resultKey: unknown;
    let governTx: GovernTransaction;
    try {
      resultKey = resultEntry[0];
      governTx = resultEntry[1];
    } catch {
      throw new Error(
        `Governor reader result entry values at index ${index} are inaccessible`,
      );
    }
    if (typeof resultKey !== 'string' || resultKey.trim().length === 0) {
      throw new Error(
        `Governor reader result key at index ${index} must be a non-empty string: ${stringifyValueForError(resultKey)}`,
      );
    }
    const normalizedResultKey = resultKey.trim();
    if (chainResults.has(normalizedResultKey)) {
      throw new Error(
        `Governor reader result key at index ${index} is duplicated: ${normalizedResultKey}`,
      );
    }
    if (governTx === undefined || governTx === null) {
      throw new Error(
        `Governor reader transaction at index ${index} must be defined`,
      );
    }
    chainResults.set(normalizedResultKey, governTx);
  }
  let timestampValue: unknown;
  try {
    timestampValue = nowFn();
  } catch {
    throw new Error('Governor reader timestamp generation failed');
  }
  const timestamp = parseNonNegativeSafeLength(
    timestampValue,
    'Governor reader timestamp',
  );
  const resultsPath = `${normalizedOutputFileName}-${timestamp}.yaml`;
  const chainResultsObject = Object.fromEntries(chainResults) as Record<
    string,
    GovernTransaction
  >;
  try {
    writeYamlFn(resultsPath, chainResultsObject);
  } catch (error) {
    throw new Error(
      `Governor reader failed to write results file ${resultsPath}: ${stringifyValueForError(error)}`,
    );
  }
  rootLogger.info(`Results written to ${resultsPath}`);

  if (errorCount > 0) {
    exitFn(1);
  }
}

export async function executePendingTransactions<T>(
  executableTxs: T[],
  txId: (tx: T) => string,
  txChain: (tx: T) => string,
  executeTx: (tx: T) => Promise<unknown>,
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
  let executableTxCountValue: unknown;
  try {
    executableTxCountValue = executableTxs.length;
  } catch {
    throw new Error('Executable transactions length is inaccessible');
  }
  try {
    executableTxCount = parseNonNegativeSafeLength(
      executableTxCountValue,
      'Executable transactions length',
    );
  } catch {
    throw new Error(
      `Executable transactions length is invalid: ${stringifyValueForError(executableTxCountValue)}`,
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
    if (tx === undefined || tx === null) {
      rootLogger.error(
        chalk.red(
          `Pending transaction at index ${index} is empty: ${stringifyValueForError(tx)}`,
        ),
      );
      failedTransactions.push({
        id: '<unknown>',
        chain: '<unknown>',
        error: new Error('Pending transaction entry is empty'),
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

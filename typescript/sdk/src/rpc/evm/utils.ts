import { Hex, Log } from 'viem';

import {
  Address,
  assert,
  isNullish,
  rootLogger,
  sleep,
} from '@hyperlane-xyz/utils';

import {
  assertIsContractAddress,
  isContractAddress,
} from '../../contracts/contracts.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { LogBlockRangeTooLargeError } from '../../providers/SmartProvider/HyperlaneJsonRpcProvider.js';
import { ChainNameOrId } from '../../types.js';
import { toNumber } from '../../utils/numbers.js';

import { GetEventLogsResponse } from './types.js';

const logger = rootLogger.child({ module: 'rpc:evm:utils' });

function toString(value: unknown, field: string): string {
  assert(typeof value === 'string', `Unable to convert ${field} to string`);
  return value;
}

function toStringArray(value: unknown, field: string): string[] {
  assert(
    Array.isArray(value) && value.every((v) => typeof v === 'string'),
    `Unable to convert ${field} to string[]`,
  );
  return value;
}

// calling getCode until the creation block is found
export async function getContractCreationBlockFromRpc(
  chain: ChainNameOrId,
  contractAddress: Address,
  multiProvider: MultiProvider,
): Promise<number> {
  await assertIsContractAddress(multiProvider, chain, contractAddress);

  const provider = multiProvider.getProvider(chain);
  const latestBlock = await provider.getBlockNumber();

  let low = 0;
  let high = latestBlock;
  let creationBlock = latestBlock;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const isContract = await isContractAddress(
      multiProvider,
      chain,
      contractAddress,
      mid,
    );

    if (isContract) {
      creationBlock = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return creationBlock;
}

export type GetLogsFromRpcOptions = {
  chain: ChainNameOrId;
  contractAddress: Address;
  multiProvider: MultiProvider;
  fromBlock: number;
  topic: string;
  toBlock?: number;
  range?: number;
};

const DEFAULT_LOG_PAGINATION_BLOCK_RANGE = 500;

const MIN_LOG_PAGINATION_BLOCK_RANGE = 1;

const LOG_PAGINATION_RETRY_BASE_MS = 100;

const LOG_PAGINATION_RETRY_MAX_MS = 1_000;

const MAX_TRANSIENT_LOG_READ_RETRIES = 3;

const MAX_ERROR_INSPECTION_DEPTH = 4;

const ERROR_TEXT_FIELDS = ['message', 'reason', 'body', 'details'];

const ERROR_NESTED_FIELDS = ['error', 'cause', 'data', 'info'];

const ERROR_HTTP_STATUS_FIELDS = ['status', 'statusCode'];

// HTTP statuses with which a provider rejects the caller rather than the query.
const TERMINAL_HTTP_STATUSES = [401, 403];

// Lowercased fragments of the same rejections as they reach us when the status
// code did not survive the trip through ethers.
const TERMINAL_ERROR_SIGNALS = [
  'unauthorized',
  'forbidden',
  'invalid api key',
  'invalid project id',
  'authentication failed',
  'must be authenticated',
];

// Lowercased fragments of the errors providers return when a single
// eth_getLogs covers more blocks (or matches more logs) than they will serve.
// Collected from Alchemy, Infura, QuickNode, Ankr, BlockPI and geth/erigon.
const BLOCK_RANGE_ERROR_SIGNALS = [
  'block range',
  'blockrange',
  'block_range',
  'range of blocks',
  'range too large',
  'requested too many blocks',
  'limit your query',
  'getlogs is limited to',
  'query returned more than',
  'query exceeds max results',
  'response size exceeded',
  'result set too large',
  'too many results',
  'too many logs',
];

function collectErrorText(error: unknown, depth = 0): string {
  if (typeof error === 'string') return error;
  if (depth >= MAX_ERROR_INSPECTION_DEPTH) return '';
  if (typeof error !== 'object' || error === null) return '';

  const parts: string[] = [];
  for (const field of ERROR_TEXT_FIELDS) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === 'string') {
      parts.push(value);
    }
  }
  for (const field of ERROR_NESTED_FIELDS) {
    const value: unknown = Reflect.get(error, field);
    if (!isNullish(value)) {
      parts.push(collectErrorText(value, depth + 1));
    }
  }

  return parts.join(' ');
}

function someNestedError(
  error: unknown,
  matches: (error: object) => boolean,
  depth = 0,
): boolean {
  if (depth >= MAX_ERROR_INSPECTION_DEPTH) return false;
  if (typeof error !== 'object' || error === null) return false;

  if (matches(error)) return true;

  return ERROR_NESTED_FIELDS.some((field) => {
    const value: unknown = Reflect.get(error, field);
    return !isNullish(value) && someNestedError(value, matches, depth + 1);
  });
}

function isTerminalErrorNode(error: object): boolean {
  if (Reflect.get(error, 'isRecoverable') === false) return true;

  return ERROR_HTTP_STATUS_FIELDS.some((field) => {
    const value: unknown = Reflect.get(error, field);
    return typeof value === 'number' && TERMINAL_HTTP_STATUSES.includes(value);
  });
}

/**
 * True when the failure is about who is asking rather than about what was
 * asked, so neither retrying nor narrowing the block range can change the
 * outcome and the error has to surface at once.
 *
 * `isRecoverable === false` is the convention `retryAsync` already honours on
 * the error it is handed, and is read here through the same nested walk as
 * {@link isBlockRangeError} so that a wrapped error is still seen, which
 * `retryAsync` itself does not do. The status and message matching beside it is
 * deliberately narrow: missing a terminal error only costs the retries and
 * halvings it takes to reach the one block minimum, whereas a false positive
 * fails a read that shrinking the range would have completed.
 */
export function isTerminalLogReadError(error: unknown): boolean {
  if (someNestedError(error, isTerminalErrorNode)) return true;

  const text = collectErrorText(error).toLowerCase();
  return TERMINAL_ERROR_SIGNALS.some((signal) => text.includes(signal));
}

/**
 * True when the provider rejected a log query because it spanned too many
 * blocks or matched too many logs, i.e. when retrying the same chunk is
 * pointless and the block range has to shrink.
 *
 * Among the failures that are not terminal this only decides how quickly the
 * range shrinks, never whether it shrinks: an unrecognised failure is retried
 * at the unchanged range first and the range is halved once those retries are
 * spent. Recognising a rate limit as a range error therefore costs a premature
 * reduction that is sticky for the rest of the scan, and failing to recognise
 * a provider's phrasing of a range error only costs the retries that precede
 * the same reduction.
 *
 * The one rejection raised inside this repository, {@link
 * LogBlockRangeTooLargeError}, is matched by type as well as by message, and is
 * looked for through the same nested walk because SmartProvider surfaces it as
 * the `cause` of its combined error. The message match is what covers every
 * external provider, so the type check is only there to keep a reword of that
 * one message from turning halving into a hard failure.
 */
export function isBlockRangeError(error: unknown): boolean {
  if (
    someNestedError(error, (node) => node instanceof LogBlockRangeTooLargeError)
  ) {
    return true;
  }

  const text = collectErrorText(error).toLowerCase();
  return BLOCK_RANGE_ERROR_SIGNALS.some((signal) => text.includes(signal));
}

export async function getLogsFromRpc({
  chain,
  contractAddress,
  multiProvider,
  fromBlock,
  topic,
  toBlock,
  range = DEFAULT_LOG_PAGINATION_BLOCK_RANGE,
}: GetLogsFromRpcOptions): Promise<GetEventLogsResponse[]> {
  assert(
    Number.isInteger(range) && range >= MIN_LOG_PAGINATION_BLOCK_RANGE,
    `Log pagination range must be an integer of at least ${MIN_LOG_PAGINATION_BLOCK_RANGE}, got ${range}`,
  );

  const provider = multiProvider.getProvider(chain);

  let currentStartBlock = fromBlock;
  const endBlock = toBlock ?? (await provider.getBlockNumber());

  let currentRange = range;
  let transientRetries = 0;

  const logs = [];
  while (currentStartBlock <= endBlock) {
    const currentEndBlock = Math.min(
      currentStartBlock + currentRange - 1,
      endBlock,
    );

    try {
      const currentLogs = await provider.getLogs({
        address: contractAddress,
        fromBlock: currentStartBlock,
        toBlock: currentEndBlock,
        topics: [topic],
      });
      logs.push(...currentLogs);
    } catch (error) {
      // Retrying and halving both assume the read can still succeed. A failure
      // that rejects the caller instead of the query never does, and would
      // otherwise burn the retry budget once per range all the way down to the
      // one block minimum before surfacing.
      if (isTerminalLogReadError(error)) {
        throw error;
      }

      const rangeRejected = isBlockRangeError(error);

      if (!rangeRejected && transientRetries < MAX_TRANSIENT_LOG_READ_RETRIES) {
        const backoffMs = Math.min(
          LOG_PAGINATION_RETRY_BASE_MS * 2 ** transientRetries,
          LOG_PAGINATION_RETRY_MAX_MS,
        );
        transientRetries++;
        logger.warn(
          { err: error },
          `Failed to read logs for ${contractAddress} on chain ${chain} between blocks ${currentStartBlock} and ${currentEndBlock}, retrying attempt ${transientRetries} of ${MAX_TRANSIENT_LOG_READ_RETRIES} in ${backoffMs}ms at the unchanged block range of ${currentRange}`,
        );
        await sleep(backoffMs);
        continue;
      }

      if (currentRange <= MIN_LOG_PAGINATION_BLOCK_RANGE) {
        throw error;
      }

      // Providers advertise wildly different maximums, so the halved range is
      // kept for the remaining chunks instead of being re-discovered on each
      // one. An unrecognised failure lands here too once its retries are spent,
      // because the alternative reading, that the signal list simply misses
      // this provider's phrasing, is only ruled out at the minimum range.
      const reducedRange = Math.max(
        Math.floor(currentRange / 2),
        MIN_LOG_PAGINATION_BLOCK_RANGE,
      );
      logger.warn(
        { err: error },
        rangeRejected
          ? `Provider rejected the block range for ${contractAddress} on chain ${chain} between blocks ${currentStartBlock} and ${currentEndBlock}, retrying with a block range of ${reducedRange}`
          : `Failed to read logs for ${contractAddress} on chain ${chain} between blocks ${currentStartBlock} and ${currentEndBlock} after ${MAX_TRANSIENT_LOG_READ_RETRIES} retries at a block range of ${currentRange}, retrying with a block range of ${reducedRange}`,
      );
      currentRange = reducedRange;
      transientRetries = 0;
      continue;
    }

    transientRetries = 0;
    currentStartBlock = currentEndBlock + 1;
  }

  return logs.map((rawLog): GetEventLogsResponse => {
    return {
      address: toString(rawLog.address, 'address'),
      blockNumber: toNumber(rawLog.blockNumber, 'blockNumber'),
      data: toString(rawLog.data, 'data'),
      logIndex: toNumber(rawLog.logIndex, 'logIndex'),
      topics: toStringArray(rawLog.topics, 'topics'),
      transactionHash: toString(rawLog.transactionHash, 'transactionHash'),
      transactionIndex: toNumber(rawLog.transactionIndex, 'transactionIndex'),
    };
  });
}

export function viemLogFromGetEventLogsResponse(
  log: GetEventLogsResponse,
): Log {
  return {
    address: log.address as Hex,
    data: log.data as Hex,
    blockNumber: BigInt(log.blockNumber),
    transactionHash: log.transactionHash as Hex,
    logIndex: Number(log.logIndex),
    transactionIndex: Number(log.transactionIndex),
    topics: log.topics as [Hex, ...Hex[]],
    blockHash: null,
    removed: false,
  };
}

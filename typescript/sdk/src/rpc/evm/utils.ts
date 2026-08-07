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

// The block every scan is safe to start from, and what this search answers
// with when it cannot establish a later one.
const GENESIS_BLOCK_NUMBER = 0;

/**
 * Finds the block a contract was deployed in by bisecting `eth_getCode` over
 * the chain's history, falling back to the genesis block where the endpoint
 * cannot serve the state of a past block.
 *
 * Every probe but the last few is a request for archive state, which an
 * endpoint that prunes answers in one of two ways. Either it fails the probe,
 * which is what the fallback below reads as "this endpoint cannot place the
 * deployment", or it reports no code at a height where the contract did exist.
 * The second is indistinguishable from a genuine pre-deployment answer on a
 * single probe, so nothing here detects it, and the search then converges on a
 * block after the deployment and a scan started there silently omits the events
 * below it. The reliable source of a deployment block is therefore the
 * explorer's getcontractcreation response, and this search is what is left
 * where there is no explorer.
 */
export async function getContractCreationBlockFromRpc(
  chain: ChainNameOrId,
  contractAddress: Address,
  multiProvider: MultiProvider,
): Promise<number> {
  await assertIsContractAddress(multiProvider, chain, contractAddress);

  const provider = multiProvider.getProvider(chain);
  const latestBlock = await provider.getBlockNumber();

  let low = GENESIS_BLOCK_NUMBER;
  let high = latestBlock;
  let creationBlock = latestBlock;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    let isContract: boolean;
    try {
      isContract = await isContractAddress(
        multiProvider,
        chain,
        contractAddress,
        mid,
      );
    } catch (error) {
      // Reported rather than rethrown because the whole scan reads the same
      // events wherever it starts below the deployment, so an endpoint that
      // cannot answer for a past block costs the request count of a full scan
      // and nothing else. It stays a warning so that the endpoint is visible
      // as pruned rather than merely slow.
      logger.warn(
        { err: error },
        `Unable to read the state of block ${mid} on chain ${chain} while searching for the deployment block of ${contractAddress}, starting from block ${GENESIS_BLOCK_NUMBER} instead`,
      );
      return GENESIS_BLOCK_NUMBER;
    }

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

// The narrowest span a failure naming neither a block range nor a result limit
// is retried at. Shrinking on one is a guess that the signal list below missed
// this provider's phrasing of a range rejection; an outage answers the same way
// at every range, and unbounded that guess costs four attempts and their
// backoffs at each of the twenty or so halvings down to one block.
//
// Bounding it by a count of halvings was only as strict as the range counted
// from: three of the 500 block default stop at 62, but three of the 1,000,000
// XERC20_LOG_SCAN_BLOCK_RANGE asks for stop at 125,000, above every cap a real
// provider enforces, so on that path the guess could never reach a span that
// would have worked. In blocks it means the same at both: from 1,000,000 it
// still reaches 7,812 and 1,953, and so a 10,000 or 2,000 block cap, and from
// 500 it still allows 500, 250, 125 and 62.
//
// A cap the registry declares never reaches here: the transport splits the
// chunk at it and refuses with LogBlockRangeTooLargeError, which is recognised
// and halves to one block unbounded. That covers flare's 30, the only declared
// maxBlockRange below this figure.
const MIN_UNRECOGNISED_FAILURE_BLOCK_RANGE = 100;

const MAX_ERROR_INSPECTION_DEPTH = 4;

const ERROR_TEXT_FIELDS = ['message', 'reason', 'body', 'details'];

const ERROR_NESTED_FIELDS = ['error', 'cause', 'data', 'info'];

const ERROR_HTTP_STATUS_FIELDS = ['status', 'statusCode'];

// HTTP statuses with which a provider rejects the caller (401, 403) or says the
// endpoint does not serve JSON-RPC at this url or verb (404, 405). Every one of
// them answers the same way however often it is asked and over whatever span.
const TERMINAL_HTTP_STATUSES = [401, 403, 404, 405];

// The JSON-RPC code for a method the endpoint does not implement, which is how
// the same rejection arrives when the transport itself answered 200.
const METHOD_NOT_FOUND_RPC_CODE = -32601;

// Lowercased fragments of the same rejections as they reach us when neither the
// status code nor the JSON-RPC code survived the trip through ethers.
const TERMINAL_ERROR_SIGNALS = [
  'unauthorized',
  'forbidden',
  'invalid api key',
  'invalid project id',
  'authentication failed',
  'must be authenticated',
  'method not found',
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
  'getlogs is limited to',
  'query returned more than',
  'query exceeds max results',
  'response size exceeded',
  'result set too large',
  'too many results',
  'too many logs',
];

// A public node phrases a span cap this way ('please limit your query to at
// most 1000 blocks') and a throttle phrases a request cap the same way ('please
// limit your query to 10 requests per second'), so on its own the fragment says
// only that something about the query was too much.
const AMBIGUOUS_QUERY_LIMIT_SIGNAL = 'limit your query to';

// Which of the two it is, is decided by whether the message says anything about
// a rate. Deciding it the other way round, by looking for a block or a result
// named near the fragment, cannot be done on what is matched here: the text is
// the whole flattened error chain, and for a getLogs failure that chain carries
// SmartProvider's echo of the request params, whose fromBlock and toBlock keys
// supply the word block whatever the provider actually said. None of the
// fragments below appear in that echo.
const REQUEST_RATE_ERROR_SIGNALS = [
  'per second',
  'per minute',
  'too many requests',
  'rate limit',
  'query rate',
  'throttl',
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
  // ethers puts its own string codes on `code`, so only the numeric JSON-RPC
  // one is a method rejection.
  if (Reflect.get(error, 'code') === METHOD_NOT_FOUND_RPC_CODE) return true;

  return ERROR_HTTP_STATUS_FIELDS.some((field) => {
    const value: unknown = Reflect.get(error, field);
    return typeof value === 'number' && TERMINAL_HTTP_STATUSES.includes(value);
  });
}

/**
 * True when the failure is about who is asking or about what the endpoint
 * serves rather than about the span that was asked for, so neither retrying nor
 * narrowing the block range can change the outcome and the error has to surface
 * at once.
 *
 * `isRecoverable === false` is the convention `retryAsync` already honours on
 * the error it is handed, and is read here through the same nested walk as
 * {@link isBlockRangeError} so that a wrapped error is still seen, which
 * `retryAsync` itself does not do. {@link LogBlockRangeTooLargeError} carries
 * that flag too, because repeating the identical request is exactly what it
 * refuses, so a caller has to ask {@link isBlockRangeError} first and reach
 * this only for what no narrower request recovers.
 *
 * The status, code and message matching beside
 * it is deliberately narrow: missing a terminal error only costs the retries and
 * halvings it takes to reach {@link MIN_UNRECOGNISED_FAILURE_BLOCK_RANGE},
 * whereas a false positive fails a read that shrinking the range would have
 * completed.
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
 * Among the failures that are not terminal this decides how quickly and how far
 * the range shrinks, never whether it shrinks: an unrecognised failure is
 * retried at the unchanged range first, the range is halved once those retries
 * are spent, and the halving stops at
 * {@link MIN_UNRECOGNISED_FAILURE_BLOCK_RANGE} instead of at the one block
 * minimum. Recognising a rate limit as a range error therefore costs a
 * premature reduction that is sticky for the rest of the scan, and failing to
 * recognise a provider's phrasing of a range error costs the retries that
 * precede the same reduction, and the read itself where the cap is narrower
 * than that floor.
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
  if (BLOCK_RANGE_ERROR_SIGNALS.some((signal) => text.includes(signal))) {
    return true;
  }

  return (
    text.includes(AMBIGUOUS_QUERY_LIMIT_SIGNAL) &&
    !REQUEST_RATE_ERROR_SIGNALS.some((signal) => text.includes(signal))
  );
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
      // Asked before the terminal check, which a range rejection also answers:
      // the identical request is refused however often it is repeated, and
      // LogBlockRangeTooLargeError says so with the same isRecoverable = false
      // that check reads. What recovers it is a narrower request, so it belongs
      // on the halving ladder rather than in the branch for failures no request
      // can recover from.
      const rangeRejected = isBlockRangeError(error);

      // Retrying and halving both assume the read can still succeed. A failure
      // that rejects the caller instead of the query never does, and would
      // otherwise burn the retry budget once per range all the way down to the
      // one block minimum before surfacing.
      if (!rangeRejected && isTerminalLogReadError(error)) {
        throw error;
      }

      // The end block clips the last chunk, so what the provider rejected is
      // the span actually asked for rather than the configured range. Halving
      // the range instead would leave a clipped chunk unchanged and re-issue
      // the identical request, once per factor of two between the two.
      const attemptedRange = currentEndBlock - currentStartBlock + 1;

      if (!rangeRejected && transientRetries < MAX_TRANSIENT_LOG_READ_RETRIES) {
        const backoffMs = Math.min(
          LOG_PAGINATION_RETRY_BASE_MS * 2 ** transientRetries,
          LOG_PAGINATION_RETRY_MAX_MS,
        );
        transientRetries++;
        logger.warn(
          { err: error },
          `Failed to read logs for ${contractAddress} on chain ${chain} between blocks ${currentStartBlock} and ${currentEndBlock}, retrying attempt ${transientRetries} of ${MAX_TRANSIENT_LOG_READ_RETRIES} in ${backoffMs}ms at the unchanged block range of ${attemptedRange}`,
        );
        await sleep(backoffMs);
        continue;
      }

      const narrowestRetriedRange = rangeRejected
        ? MIN_LOG_PAGINATION_BLOCK_RANGE
        : MIN_UNRECOGNISED_FAILURE_BLOCK_RANGE;
      if (attemptedRange <= narrowestRetriedRange) {
        throw error;
      }

      // Providers advertise wildly different maximums, so the halved range is
      // kept for the remaining chunks instead of being re-discovered on each
      // one. An unrecognised failure lands here too once its retries are spent,
      // because the alternative reading, that the signal list simply misses
      // this provider's phrasing, is only ruled out by trying a smaller range.
      const reducedRange = Math.max(
        Math.floor(attemptedRange / 2),
        MIN_LOG_PAGINATION_BLOCK_RANGE,
      );
      logger.warn(
        { err: error },
        rangeRejected
          ? `Provider rejected the block range for ${contractAddress} on chain ${chain} between blocks ${currentStartBlock} and ${currentEndBlock}, retrying with a block range of ${reducedRange}`
          : `Failed to read logs for ${contractAddress} on chain ${chain} between blocks ${currentStartBlock} and ${currentEndBlock} after ${MAX_TRANSIENT_LOG_READ_RETRIES} retries at a block range of ${attemptedRange}, retrying with a block range of ${reducedRange}`,
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

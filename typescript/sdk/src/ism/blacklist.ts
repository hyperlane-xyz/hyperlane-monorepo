import { getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { BlacklistIsm__factory } from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { viemLogFromGetEventLogsResponse } from '../rpc/evm/utils.js';
import { ChainNameOrId } from '../types.js';
import { throwIfNotMissingSelector } from '../utils/contract.js';

const logger = rootLogger.child({ module: 'BlacklistIsmUtils' });

/**
 * Puts a set of blacklisted IDs in the shape `readBlacklistedIds` returns:
 * lowercased, de-duplicated and sorted. Both of its sources go through this, so
 * a caller cannot tell which one served a set, and a config compared against one
 * has to be put in the same shape first. The log replay also relies on the
 * de-duplication, since deployments that predate on-chain enumeration emit on
 * re-adds.
 */
export function normalizeBlacklistedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

const MESSAGE_BLACKLISTED_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: BlacklistIsm__factory.abi,
    name: 'MessageBlacklisted',
  }),
);

/**
 * Reads the blacklisted message IDs of a Blacklist ISM.
 *
 * Deployments that predate on-chain enumeration expose no `values()`; for those
 * the set is replayed from `MessageBlacklisted` logs, which is exact because
 * entries are append-only. Those deployments also emit on re-adds, hence the
 * de-duplication.
 *
 * Throws when the set cannot be established, and never returns a partial list. A
 * truncated set would be diffed as "these IDs are missing on-chain" and could be
 * written back as the complete set, and a Blacklist ISM config without its
 * entries does not describe the deployment it claims to. Errors that are not a
 * missing `values()` selector propagate, so a transient RPC failure is never
 * read as a legacy deployment.
 *
 * An empty set is a result, not a failure: a Blacklist ISM that has never
 * blacklisted anything returns [].
 *
 * Result size does not constrain the replay. The explorer source walks pages
 * until one comes back short and throws when it cannot establish that, and the
 * RPC source chunks the whole block range; an explorer that cannot prove
 * completeness falls back to the RPC rather than capping the set.
 *
 * Nor does indexer lag, within a bound. A short page proves the explorer has
 * served everything it has indexed, not everything up to the requested block,
 * so where the read reaches into the recent past the explorer source re-reads
 * that part over RPC and merges the two. Entries added while the explorer was
 * behind are recovered that way, which matters because a redeploy — the path
 * this design takes for deployments that predate on-chain enumeration — seeds
 * the replacement from the target config, so an entry missing from a set
 * persisted into a registry would be dropped permanently.
 *
 * Two things that re-read does not cover. It spans a fixed duration below the
 * chain head, so an explorer lagging further behind than that can still
 * under-report, and a read that ends before that window is left to the explorer
 * alone. And it starts no earlier than the explorer's own last record, so
 * a record the explorer silently omitted from earlier in the range is not
 * recovered; the same applies to an explorer that serves a shorter page than
 * asked for, which the walk reads as the end of the data.
 */
export async function readBlacklistedIds(
  chain: ChainNameOrId,
  address: Address,
  multiProvider: MultiProvider,
  eventLogsReader?: EvmEventLogsReader,
): Promise<string[]> {
  const blacklistIsm = BlacklistIsm__factory.connect(
    address,
    multiProvider.getProvider(chain),
  );

  try {
    return normalizeBlacklistedIds(await blacklistIsm.values());
  } catch (error) {
    throwIfNotMissingSelector(error);
    logger.debug(
      { chain, address },
      'Error accessing "values" property, implying this is a Blacklist ISM that predates on-chain enumeration.',
    );
  }

  const logsReader =
    eventLogsReader ?? EvmEventLogsReader.fromConfig({ chain }, multiProvider);

  try {
    const logs = await logsReader.getLogsByTopic({
      contractAddress: address,
      eventTopic: MESSAGE_BLACKLISTED_EVENT_SELECTOR,
    });

    const events = parseEventLogs({
      abi: BlacklistIsm__factory.abi,
      eventName: 'MessageBlacklisted',
      logs: logs.map(viemLogFromGetEventLogsResponse),
    });

    return normalizeBlacklistedIds(events.map((event) => event.args.messageId));
  } catch (error) {
    throw new Error(
      `Unable to read the blacklisted IDs of the Blacklist ISM at "${address}" on chain "${chain}": rebuilding the set from MessageBlacklisted logs failed`,
      { cause: error },
    );
  }
}

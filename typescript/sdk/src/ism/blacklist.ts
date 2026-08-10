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
 * Result size does not constrain the replay. `EvmEventLogsReader` reads a block
 * explorer first, and that path pages until a page comes back short; a range
 * holding more logs than the explorer will page through, or a page it fails to
 * serve, raises an unrecoverable error rather than a prefix of the range, which
 * moves the read to the RPC fallback. That fallback pages by block range and so
 * has no equivalent ceiling.
 *
 * Indexer lag is not covered, and this is where the replay can be wrong. The
 * explorer path trusts the explorer's index: a set read while the explorer is
 * behind the chain omits entries that are already on-chain and is reported as
 * complete, since nothing in the response distinguishes the two. Append-only
 * entries do not make that harmless. An in-place update computed from a stale
 * set only re-adds an entry that is already set, but a redeploy — the path this
 * design takes for deployments that predate on-chain enumeration — seeds the
 * replacement from the target config, so an entry missing from a stale set that
 * was persisted into a registry is dropped permanently. This is shared
 * `EvmEventLogsReader` behaviour rather than anything specific to blacklists;
 * every consumer reading logs through an explorer has the same exposure.
 *
 * The lower bound of the replay carries a related caveat. No `fromBlock` is
 * passed, so the reader derives one: the explorer reports the deployment block
 * and that answer is cached, so losing the explorer partway through a read does
 * not lose the bound. Where no explorer is configured, or where the explorer
 * cannot answer for the contract at all, the bound comes from bisecting
 * `eth_getCode` instead, and `getContractCreationBlockFromRpc` documents why an
 * endpoint that prunes silently defeats that: reporting no code at a height the
 * contract did exist reads as a genuine pre-deployment answer, so the search
 * settles above the deployment and the replay starts too late. The same helper
 * bounds every log read in the SDK, so this is not specific to blacklists.
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

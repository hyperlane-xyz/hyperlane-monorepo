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
 * the set is replayed from `MessageBlacklisted` logs. Entries are append-only,
 * so a complete log sequence defines the current set. Those deployments also
 * emit on re-adds, hence the de-duplication.
 *
 * Throws rather than returning a set it can tell is incomplete. A truncated set
 * would be diffed as "these IDs are missing on-chain" and could be written back
 * as the complete set, and a Blacklist ISM config without its entries does not
 * describe the deployment it claims to. Errors that are not a missing `values()`
 * selector propagate, so a transient RPC failure is never read as a legacy
 * deployment.
 *
 * What it cannot tell is covered by the caveat at the end of this comment:
 * a source that answers successfully but incompletely is taken at its word,
 * because nothing in such a response distinguishes it from a complete one.
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
 * The replay requires an explorer-derived deployment block. The explorer either
 * reports the block directly or supplies the deployment transaction whose
 * receipt establishes it. That bound is passed explicitly to the log reader, so
 * an explorer log failure can still fall back to RPC without replacing the
 * bound with one derived by bisecting historical `eth_getCode` responses.
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
    const fromBlock =
      await logsReader.getContractDeploymentBlockFromExplorer(address);
    const logs = await logsReader.getLogsByTopic({
      contractAddress: address,
      eventTopic: MESSAGE_BLACKLISTED_EVENT_SELECTOR,
      fromBlock,
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

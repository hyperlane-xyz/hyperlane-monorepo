import { getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { BlacklistIsm__factory } from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { viemLogFromGetEventLogsResponse } from '../rpc/evm/utils.js';
import { ChainNameOrId } from '../types.js';
import { throwIfNotMissingSelector } from '../utils/contract.js';

const logger = rootLogger.child({ module: 'BlacklistIsmUtils' });

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
 * Returns undefined when the set cannot be established, never a partial list: a
 * truncated set would be diffed as "these IDs are missing on-chain" and could be
 * written back as the complete set. Errors that are not a missing `values()`
 * selector propagate, so a transient RPC failure is never read as a legacy
 * deployment.
 *
 * Result size does not constrain the replay. The explorer source walks pages
 * until one comes back short and throws when it cannot establish that, and the
 * RPC source chunks the whole block range; an explorer that cannot prove
 * completeness falls back to the RPC rather than capping the set. The explorer
 * source treats a short page as proof it has reached the end, so that guarantee
 * holds for explorers that honour the requested page size — one that silently
 * serves a smaller page would look complete on its first response.
 *
 * The replay's other limitation is that the explorer path
 * trusts the explorer's indexer. A set read within the indexing window can omit an ID that
 * is already on-chain and still look complete. Append-only entries do not make
 * this harmless: an in-place update computed from a stale set only re-adds an ID
 * that is already set, but a redeploy — which this design deliberately takes for
 * deployments that predate on-chain enumeration — seeds the replacement from the
 * target config, so an ID missing from a stale set that was persisted into a
 * registry is dropped permanently. This is a property of the shared
 * `EvmEventLogsReader` explorer-primary strategy rather than of blacklist
 * enumeration: `EvmTimelockReader` reads through the same path with the same
 * exposure, which is why it is recorded here instead of worked around locally.
 */
export async function readBlacklistedIds(
  chain: ChainNameOrId,
  address: Address,
  multiProvider: MultiProvider,
  eventLogsReader?: EvmEventLogsReader,
): Promise<string[] | undefined> {
  const blacklistIsm = BlacklistIsm__factory.connect(
    address,
    multiProvider.getProvider(chain),
  );

  try {
    return [...(await blacklistIsm.values())];
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

    return [
      ...new Set(events.map((event) => event.args.messageId.toLowerCase())),
    ].sort();
  } catch (error) {
    logger.warn(
      { chain, address, error },
      'Failed to rebuild the blacklisted ID set from logs; reporting it as unknown.',
    );
    return undefined;
  }
}

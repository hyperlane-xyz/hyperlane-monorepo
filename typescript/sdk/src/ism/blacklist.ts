import { getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { BlacklistIsm__factory } from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EvmEventLogsReader,
  EvmEventLogsSource,
} from '../rpc/evm/EvmEventLogsReader.js';
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

// Etherscan-like explorers cap `logs/getLogs` at this many records and report a
// capped page with a success status, so a response of exactly this size cannot
// be distinguished from a truncated one.
const EXPLORER_LOGS_PAGE_SIZE = 1000;

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
 * Two limitations of the replay are known and accepted:
 *
 * - The explorer path trusts the explorer's indexer. A set read within the
 *   indexing window can omit an ID that is already on-chain and still look
 *   complete. Append-only entries do not make this harmless: an in-place update
 *   computed from a stale set only re-adds an ID that is already set, but a
 *   redeploy — which this design deliberately takes for deployments that predate
 *   on-chain enumeration — seeds the replacement from the target config, so an
 *   ID missing from a stale set that was persisted into a registry is dropped
 *   permanently. This is a property of the shared `EvmEventLogsReader`
 *   explorer-primary strategy rather than of blacklist enumeration:
 *   `EvmTimelockReader` reads through the same path with the same exposure,
 *   which is why it is recorded here instead of worked around locally.
 * - The page-cap guard below applies only to the explorer source, whose response
 *   is capped at a page and reported as a success. The RPC source walks the
 *   whole block range in chunks and has no such cap, so a complete set of 1000
 *   or more entries read over RPC is returned rather than rejected.
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
    const { logs, source } = await logsReader.getLogsByTopicWithSource({
      contractAddress: address,
      eventTopic: MESSAGE_BLACKLISTED_EVENT_SELECTOR,
    });

    if (
      source === EvmEventLogsSource.Explorer &&
      logs.length >= EXPLORER_LOGS_PAGE_SIZE
    ) {
      logger.warn(
        { chain, address, logCount: logs.length },
        'Blacklist ISM log replay filled an explorer page and cannot be proven complete; reporting the set as unknown.',
      );
      return undefined;
    }

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

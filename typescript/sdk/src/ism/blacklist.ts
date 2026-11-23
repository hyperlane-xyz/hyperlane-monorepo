import { providers } from 'ethers';
import { getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { BlacklistIsm__factory } from '@hyperlane-xyz/core';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { EthJsonRpcBlockParameterTag } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { HyperlaneSmartProvider } from '../providers/SmartProvider/SmartProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { viemLogFromGetEventLogsResponse } from '../rpc/evm/utils.js';
import { buildBlockTagOverrides } from '../token/adapters/utils.js';
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

const HEX_QUANTITY_REGEX = /^0x(0|[1-9a-f][0-9a-f]*)$/i;

/**
 * Resolves a block tag to a block number with one raw `eth_getBlockByNumber`
 * request. ethers' `getBlock` is avoided because, for a named tag the RPC
 * answers with `null`, it keeps polling instead of failing.
 */
async function resolveBlockNumber(
  chain: ChainNameOrId,
  provider: providers.Provider,
  blockTag: number | EthJsonRpcBlockParameterTag,
): Promise<number> {
  if (typeof blockTag === 'number') return blockTag;

  const params = [blockTag, false];
  let block: unknown;
  if (provider instanceof HyperlaneSmartProvider) {
    block = await provider.sendReadRpc('eth_getBlockByNumber', params);
  } else if (provider instanceof providers.JsonRpcProvider) {
    block = await provider.send('eth_getBlockByNumber', params);
  } else {
    throw new Error(
      `Cannot resolve block tag "${blockTag}" on chain ${chain}: the provider does not support raw RPC requests`,
    );
  }

  assert(
    typeof block === 'object' && block !== null && 'number' in block,
    `Block tag "${blockTag}" not supported by RPC provider for chain ${chain}`,
  );
  const { number } = block;
  assert(
    typeof number === 'string' && HEX_QUANTITY_REGEX.test(number),
    `Invalid block number for block tag "${blockTag}" on chain ${chain}: ${String(number)}`,
  );
  const blockNumber = parseInt(number, 16);
  assert(
    Number.isSafeInteger(blockNumber),
    `Invalid block number for block tag "${blockTag}" on chain ${chain}: ${number}`,
  );
  return blockNumber;
}

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
 *
 * `blockTag` reads the set as of that block instead of the latest one: it is
 * passed to `values()`, and the log replay stops at it, resolving a named tag
 * such as `finalized` to its block number first. A Blacklist ISM the explorer
 * reports as deployed after that block had no entries at it, so its set is [].
 */
export async function readBlacklistedIds(
  chain: ChainNameOrId,
  address: Address,
  multiProvider: MultiProvider,
  eventLogsReader?: EvmEventLogsReader,
  blockTag?: number | EthJsonRpcBlockParameterTag,
): Promise<string[]> {
  const provider = multiProvider.getProvider(chain);
  const blacklistIsm = BlacklistIsm__factory.connect(address, provider);

  try {
    return normalizeBlacklistedIds(
      await blacklistIsm.values(buildBlockTagOverrides(blockTag)),
    );
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
    const query: Parameters<EvmEventLogsReader['getLogsByTopic']>[0] = {
      contractAddress: address,
      eventTopic: MESSAGE_BLACKLISTED_EVENT_SELECTOR,
      fromBlock,
    };
    if (blockTag !== undefined) {
      const toBlock = await resolveBlockNumber(chain, provider, blockTag);
      if (toBlock < fromBlock) return [];
      query.toBlock = toBlock;
    }
    const logs = await logsReader.getLogsByTopic(query);

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

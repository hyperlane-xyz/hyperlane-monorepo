import { parseEventLogs } from 'viem';

import { Address, normalizeAddress, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  EvmXERC20Adapter,
  EvmXERC20VSAdapter,
} from './adapters/EvmTokenAdapter.js';
import { RateLimitMidPoint, xERC20Limits } from './adapters/ITokenAdapter.js';
import { XERC20Type } from './types.js';
import {
  CONFIGURATION_CHANGED_EVENT_SELECTOR,
  XERC20_VS_ABI,
} from './xerc20-abi.js';
import { deriveXERC20TokenType } from './xerc20.js';

export interface StandardXERC20Limits {
  type: typeof XERC20Type.Standard;
  mint: string;
  burn: string;
}

export interface VeloXERC20Limits {
  type: typeof XERC20Type.Velo;
  bufferCap: string;
  rateLimitPerSecond: string;
}

/**
 * Unified XERC20 limits type
 */
export type XERC20Limits = StandardXERC20Limits | VeloXERC20Limits;

/**
 * Map of bridge addresses to their limits
 */
export type XERC20LimitsMap = Record<Address, XERC20Limits>;

/**
 * Reader for on-chain XERC20 state.
 * Reads limits and bridge configurations from XERC20 contracts.
 */
export class EvmXERC20Reader extends HyperlaneReader {
  protected logger = rootLogger.child({ module: 'EvmXERC20Reader' });
  protected readonly multiProtocolProvider: MultiProtocolProvider;

  constructor(
    protected readonly multiProvider: MultiProvider,
    chain: ChainNameOrId,
  ) {
    super(multiProvider, chain);
    this.multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);
  }

  async deriveXERC20TokenType(xERC20Address: Address): Promise<XERC20Type> {
    return deriveXERC20TokenType(this.multiProvider, this.chain, xERC20Address);
  }

  /**
   * Read current limits for the specified bridges.
   */
  async readLimits(
    xERC20Address: Address,
    bridges: Address[],
    type: XERC20Type,
  ): Promise<XERC20LimitsMap> {
    const limitsMap: XERC20LimitsMap = {};
    const chainName = this.multiProvider.getChainName(this.chain);

    if (type === XERC20Type.Standard) {
      const adapter = new EvmXERC20Adapter(
        chainName,
        this.multiProtocolProvider,
        { token: xERC20Address },
      );

      for (const bridge of bridges) {
        const limits = await adapter.getLimits(bridge);
        limitsMap[bridge] = this.toStandardLimits(limits);
      }
    } else {
      const adapter = new EvmXERC20VSAdapter(
        chainName,
        this.multiProtocolProvider,
        { token: xERC20Address },
      );

      for (const bridge of bridges) {
        const rateLimits = await adapter.getRateLimits(bridge);
        limitsMap[bridge] = this.toVeloLimits(rateLimits);
      }
    }

    return limitsMap;
  }

  /**
   * Read all bridges configured on-chain for a Velodrome XERC20 by parsing ConfigurationChanged events.
   * Returns empty array for Standard XERC20 since it has no event-based bridge enumeration.
   * Note: Queries from block 0 which may be slow on chains with long histories.
   */
  async readOnChainBridges(
    xERC20Address: Address,
    type: XERC20Type,
  ): Promise<Address[]> {
    if (type === XERC20Type.Standard) {
      this.logger.debug(
        'Standard XERC20 does not support on-chain bridge enumeration',
      );
      return [];
    }

    const filter = {
      address: xERC20Address,
      topics: [CONFIGURATION_CHANGED_EVENT_SELECTOR],
      fromBlock: 0,
      toBlock: 'latest',
    };

    const rawLogs = await this.provider.getLogs(filter);

    const logs = rawLogs.map((log) => ({
      address: log.address as `0x${string}`,
      blockHash: log.blockHash as `0x${string}`,
      blockNumber: BigInt(log.blockNumber),
      data: log.data as `0x${string}`,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash as `0x${string}`,
      transactionIndex: log.transactionIndex,
      removed: log.removed,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    }));

    const parsedLogs = parseEventLogs({
      abi: XERC20_VS_ABI,
      eventName: 'ConfigurationChanged',
      logs,
    });

    // Track latest log per bridge (use logIndex as tiebreaker for same block)
    const bridgeToLatestLog = new Map<string, (typeof parsedLogs)[0]>();
    for (const log of parsedLogs) {
      const bridge = normalizeAddress(log.args.bridge);
      const existing = bridgeToLatestLog.get(bridge);
      const isMoreRecent =
        !existing ||
        log.blockNumber > existing.blockNumber ||
        (log.blockNumber === existing.blockNumber &&
          log.logIndex > existing.logIndex);
      if (isMoreRecent) {
        bridgeToLatestLog.set(bridge, log);
      }
    }

    // Filter to active bridges (non-zero limits)
    const activeBridges: Address[] = [];
    for (const [bridge, log] of bridgeToLatestLog) {
      const hasNonZeroLimits =
        log.args.bufferCap !== 0n || log.args.rateLimitPerSecond !== 0n;
      if (hasNonZeroLimits) {
        activeBridges.push(bridge);
      }
    }

    return activeBridges;
  }

  protected toStandardLimits(limits: xERC20Limits): StandardXERC20Limits {
    return {
      type: XERC20Type.Standard,
      mint: limits.mint.toString(),
      burn: limits.burn.toString(),
    };
  }

  protected toVeloLimits(rateLimits: RateLimitMidPoint): VeloXERC20Limits {
    return {
      type: XERC20Type.Velo,
      bufferCap: rateLimits.bufferCap.toString(),
      rateLimitPerSecond: rateLimits.rateLimitPerSecond.toString(),
    };
  }
}

export function limitsAreZero(limits: XERC20Limits): boolean {
  if (limits.type === XERC20Type.Standard) {
    return limits.mint === '0' && limits.burn === '0';
  }
  return limits.bufferCap === '0' && limits.rateLimitPerSecond === '0';
}

export function limitsMatch(a: XERC20Limits, b: XERC20Limits): boolean {
  if (a.type !== b.type) return false;

  if (a.type === XERC20Type.Standard && b.type === XERC20Type.Standard) {
    return a.mint === b.mint && a.burn === b.burn;
  }

  if (a.type === XERC20Type.Velo && b.type === XERC20Type.Velo) {
    return (
      a.bufferCap === b.bufferCap &&
      a.rateLimitPerSecond === b.rateLimitPerSecond
    );
  }

  return false;
}

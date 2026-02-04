import { getAbiItem, parseEventLogs, toEventSelector } from 'viem';

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
import { detectXERC20Type } from './xerc20.js';

/**
 * Minimal ABI for parsing ConfigurationChanged events from Velodrome XERC20
 */
const minimalXERC20VSABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'bridge',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint112',
        name: 'bufferCap',
        type: 'uint112',
      },
      {
        indexed: false,
        internalType: 'uint128',
        name: 'rateLimitPerSecond',
        type: 'uint128',
      },
    ],
    name: 'ConfigurationChanged',
    type: 'event',
  },
] as const;

const CONFIGURATION_CHANGED_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: minimalXERC20VSABI,
    name: 'ConfigurationChanged',
  }),
);

/**
 * Standard XERC20 limits (mint/burn max limits)
 */
export interface StandardXERC20Limits {
  type: 'standard';
  mint: string; // uint256 as string
  burn: string; // uint256 as string
}

/**
 * Velodrome XERC20 limits (bufferCap/rateLimitPerSecond)
 */
export interface VelodromeXERC20Limits {
  type: 'velodrome';
  bufferCap: string;
  rateLimitPerSecond: string;
}

/**
 * Unified XERC20 limits type
 */
export type XERC20Limits = StandardXERC20Limits | VelodromeXERC20Limits;

/**
 * Map of bridge addresses to their limits
 */
export type XERC20LimitsMap = Record<Address, XERC20Limits>;

/**
 * XERC20 type discriminator
 */
export type XERC20Type = 'standard' | 'velodrome';

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

  /**
   * Detect the XERC20 type (standard or velodrome) by checking bytecode selectors.
   */
  async detectType(xERC20Address: Address): Promise<XERC20Type> {
    return detectXERC20Type(this.provider, xERC20Address);
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

    if (type === 'standard') {
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
        limitsMap[bridge] = this.toVelodromeLimits(rateLimits);
      }
    }

    return limitsMap;
  }

  /**
   * Read all bridges configured on-chain for a Velodrome XERC20 by parsing ConfigurationChanged events.
   * Returns empty array for Standard XERC20 since it has no event-based bridge enumeration.
   */
  async readOnChainBridges(
    xERC20Address: Address,
    type: XERC20Type,
  ): Promise<Address[]> {
    if (type === 'standard') {
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
      abi: minimalXERC20VSABI,
      eventName: 'ConfigurationChanged',
      logs,
    });

    // Track latest log per bridge
    const bridgeToLatestLog = new Map<string, (typeof parsedLogs)[0]>();
    for (const log of parsedLogs) {
      const bridge = normalizeAddress(log.args.bridge);
      const existing = bridgeToLatestLog.get(bridge);
      if (!existing || log.blockNumber > existing.blockNumber) {
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

  /**
   * Convert xERC20Limits to StandardXERC20Limits
   */
  protected toStandardLimits(limits: xERC20Limits): StandardXERC20Limits {
    return {
      type: 'standard',
      mint: limits.mint.toString(),
      burn: limits.burn.toString(),
    };
  }

  /**
   * Convert RateLimitMidPoint to VelodromeXERC20Limits
   */
  protected toVelodromeLimits(
    rateLimits: RateLimitMidPoint,
  ): VelodromeXERC20Limits {
    return {
      type: 'velodrome',
      bufferCap: rateLimits.bufferCap.toString(),
      rateLimitPerSecond: rateLimits.rateLimitPerSecond.toString(),
    };
  }
}

/**
 * Check if limits are zero (bridge not configured)
 */
export function limitsAreZero(limits: XERC20Limits): boolean {
  if (limits.type === 'standard') {
    return limits.mint === '0' && limits.burn === '0';
  }
  return limits.bufferCap === '0' && limits.rateLimitPerSecond === '0';
}

/**
 * Check if two limits match
 */
export function limitsMatch(a: XERC20Limits, b: XERC20Limits): boolean {
  if (a.type !== b.type) return false;

  if (a.type === 'standard' && b.type === 'standard') {
    return a.mint === b.mint && a.burn === b.burn;
  }

  if (a.type === 'velodrome' && b.type === 'velodrome') {
    return (
      a.bufferCap === b.bufferCap &&
      a.rateLimitPerSecond === b.rateLimitPerSecond
    );
  }

  return false;
}

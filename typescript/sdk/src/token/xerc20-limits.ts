import { Address, assert, concurrentMap } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainName } from '../types.js';

import {
  EvmXERC20Adapter,
  EvmXERC20VSAdapter,
} from './adapters/EvmTokenAdapter.js';
import { RateLimitMidPoint, xERC20Limits } from './adapters/ITokenAdapter.js';
import { XERC20Type } from './types.js';

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

export function toStandardLimits(limits: xERC20Limits): StandardXERC20Limits {
  return {
    type: XERC20Type.Standard,
    mint: limits.mint.toString(),
    burn: limits.burn.toString(),
  };
}

export function toVeloLimits(rateLimits: RateLimitMidPoint): VeloXERC20Limits {
  return {
    type: XERC20Type.Velo,
    bufferCap: rateLimits.bufferCap.toString(),
    rateLimitPerSecond: rateLimits.rateLimitPerSecond.toString(),
  };
}

/**
 * The conversions from what a token's getters return to the limits this SDK
 * reports. EvmXERC20Reader exposes them as protected methods, so its
 * readLimits hands its own bound versions here and a subclass overriding one
 * still decides what its reader reports.
 */
export interface XERC20LimitsConverters {
  toStandardLimits: (limits: xERC20Limits) => StandardXERC20Limits;
  toVeloLimits: (rateLimits: RateLimitMidPoint) => VeloXERC20Limits;
}

/**
 * Reads the current limits the xERC20 holds for each bridge, keyed by the
 * bridge address as it was passed in.
 *
 * Which getter answers depends on the implementation, so the type decides:
 * Velodrome exposes the whole rate limit struct through `rateLimits`, while a
 * canonical xERC20 exposes `mintingMaxLimitOf`/`burningMaxLimitOf`. Both are
 * read from the token itself rather than from the events it emitted, so a
 * limit changed by an implementation that emits nothing, or emits an event
 * this SDK does not know, is still reported at its current value.
 *
 * The bridges are read at the chain's configured RPC concurrency. Discovery
 * hands over every address the token ever announced, deactivated ones included
 * because the zero-limit filter runs on what is read here, and a Standard token
 * costs two calls per bridge, so a token with a long history would otherwise
 * open that whole history's worth of reads at once.
 */
export async function readXERC20Limits({
  multiProtocolProvider,
  chain,
  xERC20Address,
  bridges,
  type,
  converters = { toStandardLimits, toVeloLimits },
}: {
  multiProtocolProvider: MultiProtocolProvider;
  chain: ChainName;
  xERC20Address: Address;
  bridges: Address[];
  type: XERC20Type;
  converters?: XERC20LimitsConverters;
}): Promise<XERC20LimitsMap> {
  const readLimitsOf =
    type === XERC20Type.Standard
      ? standardLimitsReader(
          chain,
          multiProtocolProvider,
          xERC20Address,
          converters.toStandardLimits,
        )
      : veloLimitsReader(
          chain,
          multiProtocolProvider,
          xERC20Address,
          converters.toVeloLimits,
        );

  const limits = await concurrentMap(
    multiProtocolProvider.tryGetRpcConcurrency(chain) ??
      DEFAULT_CONTRACT_READ_CONCURRENCY,
    bridges,
    readLimitsOf,
  );

  const limitsMap: XERC20LimitsMap = {};
  bridges.forEach((bridge, index) => {
    const bridgeLimits = limits[index];
    assert(bridgeLimits, `Missing xERC20 limits for bridge ${bridge}`);
    limitsMap[bridge] = bridgeLimits;
  });

  return limitsMap;
}

function standardLimitsReader(
  chain: ChainName,
  multiProtocolProvider: MultiProtocolProvider,
  xERC20Address: Address,
  toLimits: XERC20LimitsConverters['toStandardLimits'],
): (bridge: Address) => Promise<XERC20Limits> {
  const adapter = new EvmXERC20Adapter(chain, multiProtocolProvider, {
    token: xERC20Address,
  });

  return async (bridge) => toLimits(await adapter.getLimits(bridge));
}

function veloLimitsReader(
  chain: ChainName,
  multiProtocolProvider: MultiProtocolProvider,
  xERC20Address: Address,
  toLimits: XERC20LimitsConverters['toVeloLimits'],
): (bridge: Address) => Promise<XERC20Limits> {
  const adapter = new EvmXERC20VSAdapter(chain, multiProtocolProvider, {
    token: xERC20Address,
  });

  return async (bridge) => toLimits(await adapter.getRateLimits(bridge));
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

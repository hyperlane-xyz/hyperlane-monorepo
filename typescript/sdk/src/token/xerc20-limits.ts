import {
  Address,
  assert,
  concurrentMap,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { UIN256_MAX_VALUE } from '../consts/numbers.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainName } from '../types.js';

import {
  EvmXERC20AevoAdapter,
  EvmXERC20Adapter,
  EvmXERC20VSAdapter,
} from './adapters/EvmTokenAdapter.js';
import {
  AevoMintAuthority,
  RateLimitMidPoint,
  toAevoLimits,
  xERC20Limits,
} from './adapters/ITokenAdapter.js';
import {
  XERC20AevoCapConfig,
  XERC20AevoCapType,
  XERC20AevoLimitConfig,
  XERC20Type,
} from './types.js';

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
 * What an Aevo token holds for a minter, as a config states it: that the minter
 * is not authorized, which says nothing of the cap the token keeps for it, or
 * that it is authorized with a cap, raw or unlimited. Unlimited is the cap of
 * zero on which the token mints without bound.
 *
 * A cap bounds what the minter has outstanding, what it has minted and not
 * burned: the token keeps that count for each minter, refuses a mint that takes
 * it beyond the cap, and lowers it with a burn.
 */
export type AevoXERC20Limits = XERC20AevoLimitConfig;

/**
 * Unified XERC20 limits type
 */
export type XERC20Limits =
  | StandardXERC20Limits
  | VeloXERC20Limits
  | AevoXERC20Limits;

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
 * The cap the token keeps for a minter, from the cap a config declares for it.
 * The inverse of what toAevoLimits reads from an authorized minter. A raw cap
 * has to be a positive uint256: the token reads a cap of zero as no cap, which
 * only an unlimited cap declares.
 */
export function aevoCapToUint256(cap: XERC20AevoCapConfig): bigint {
  switch (cap.type) {
    case XERC20AevoCapType.Unlimited:
      return 0n;
    case XERC20AevoCapType.Raw: {
      const value = BigInt(cap.value);
      assert(
        value > 0n && value <= UIN256_MAX_VALUE,
        `A raw Aevo cap must be a positive uint256, got ${cap.value}`,
      );
      return value;
    }
    default: {
      const exhaustiveCheck: never = cap;
      throw new Error(
        `Unknown Aevo cap: ${stringifyObject(exhaustiveCheck, 'json')}`,
      );
    }
  }
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
  toAevoLimits: (authority: AevoMintAuthority) => AevoXERC20Limits;
}

/**
 * Reads the current limits the xERC20 holds for each bridge, keyed by the
 * bridge address as it was passed in.
 *
 * Which getter answers depends on the implementation, so the type decides:
 * Velodrome exposes the whole rate limit struct through `rateLimits`, a
 * canonical xERC20 exposes `mintingMaxLimitOf`/`burningMaxLimitOf`, and an Aevo
 * token exposes `authorities`/`caps`. All are
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
  converters = { toStandardLimits, toVeloLimits, toAevoLimits },
}: {
  multiProtocolProvider: MultiProtocolProvider;
  chain: ChainName;
  xERC20Address: Address;
  bridges: Address[];
  type: XERC20Type;
  converters?: XERC20LimitsConverters;
}): Promise<XERC20LimitsMap> {
  const readLimitsOf = limitsReader(
    type,
    chain,
    multiProtocolProvider,
    xERC20Address,
    converters,
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

function limitsReader(
  type: XERC20Type,
  chain: ChainName,
  multiProtocolProvider: MultiProtocolProvider,
  xERC20Address: Address,
  converters: XERC20LimitsConverters,
): (bridge: Address) => Promise<XERC20Limits> {
  const addresses = { token: xERC20Address };

  switch (type) {
    case XERC20Type.Standard: {
      const adapter = new EvmXERC20Adapter(
        chain,
        multiProtocolProvider,
        addresses,
      );
      return async (bridge) =>
        converters.toStandardLimits(await adapter.getLimits(bridge));
    }
    case XERC20Type.Velo: {
      const adapter = new EvmXERC20VSAdapter(
        chain,
        multiProtocolProvider,
        addresses,
      );
      return async (bridge) =>
        converters.toVeloLimits(await adapter.getRateLimits(bridge));
    }
    case XERC20Type.Aevo: {
      const adapter = new EvmXERC20AevoAdapter(
        chain,
        multiProtocolProvider,
        addresses,
      );
      return async (bridge) =>
        converters.toAevoLimits(await adapter.getMintAuthority(bridge));
    }
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unknown xERC20 type: ${exhaustiveCheck}`);
    }
  }
}

export function limitsAreZero(limits: XERC20Limits): boolean {
  switch (limits.type) {
    case XERC20Type.Standard:
      return limits.mint === '0' && limits.burn === '0';
    case XERC20Type.Velo:
      return limits.bufferCap === '0' && limits.rateLimitPerSecond === '0';
    case XERC20Type.Aevo:
      return !limits.authorized;
    default: {
      const exhaustiveCheck: never = limits;
      throw new Error(
        `Unknown xERC20 limits: ${stringifyObject(exhaustiveCheck, 'json')}`,
      );
    }
  }
}

export function limitsMatch(a: XERC20Limits, b: XERC20Limits): boolean {
  switch (a.type) {
    case XERC20Type.Standard:
      return (
        b.type === XERC20Type.Standard && a.mint === b.mint && a.burn === b.burn
      );
    case XERC20Type.Velo:
      return (
        b.type === XERC20Type.Velo &&
        a.bufferCap === b.bufferCap &&
        a.rateLimitPerSecond === b.rateLimitPerSecond
      );
    case XERC20Type.Aevo:
      if (b.type !== XERC20Type.Aevo) return false;
      // A minter that is not authorized declares no cap to compare.
      if (!a.authorized || !b.authorized) return a.authorized === b.authorized;
      return aevoCapsMatch(a.cap, b.cap);
    default: {
      const exhaustiveCheck: never = a;
      throw new Error(
        `Unknown xERC20 limits: ${stringifyObject(exhaustiveCheck, 'json')}`,
      );
    }
  }
}

function aevoCapsMatch(
  a: XERC20AevoCapConfig,
  b: XERC20AevoCapConfig,
): boolean {
  switch (a.type) {
    case XERC20AevoCapType.Unlimited:
      return b.type === XERC20AevoCapType.Unlimited;
    case XERC20AevoCapType.Raw:
      return b.type === XERC20AevoCapType.Raw && a.value === b.value;
    default: {
      const exhaustiveCheck: never = a;
      throw new Error(
        `Unknown Aevo cap: ${stringifyObject(exhaustiveCheck, 'json')}`,
      );
    }
  }
}

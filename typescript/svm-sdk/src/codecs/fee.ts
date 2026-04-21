import type { ReadonlyUint8Array } from '@solana/kit';

import { concatBytes, option, u8, u32le, u64le, vec } from './binary.js';
import { FeeDataKind, type FeeStrategyKind } from '../fee/types.js';

// ── Account discriminators (8 bytes each, ASCII) ────────────────────

export const FEE_ACCOUNT_DISCRIMINATOR = new TextEncoder().encode('FEE_ACCT');
export const ROUTE_DOMAIN_DISCRIMINATOR = new TextEncoder().encode('ROUTEDOM');
export const CC_ROUTE_DISCRIMINATOR = new TextEncoder().encode('CC_ROUTE');
export const TRANSIENT_QUOTE_DISCRIMINATOR = new TextEncoder().encode(
  'TRNQUOTE',
);
export const STANDING_QUOTE_DISCRIMINATOR = new TextEncoder().encode(
  'STDQUOTE',
);

// ── Fee params ──────────────────────────────────────────────────────

export interface SvmFeeParams {
  maxFee: bigint;
  halfAmount: bigint;
}

export function encodeFeeParams(params: SvmFeeParams): ReadonlyUint8Array {
  return concatBytes(u64le(params.maxFee), u64le(params.halfAmount));
}

// ── Fee data strategy ───────────────────────────────────────────────

export type SvmFeeDataStrategy =
  | { kind: typeof FeeStrategyKind.Linear; params: SvmFeeParams }
  | { kind: typeof FeeStrategyKind.Regressive; params: SvmFeeParams }
  | { kind: typeof FeeStrategyKind.Progressive; params: SvmFeeParams };

export function encodeFeeDataStrategy(
  strategy: SvmFeeDataStrategy,
): ReadonlyUint8Array {
  return concatBytes(u8(strategy.kind), encodeFeeParams(strategy.params));
}

// ── BTreeSet<H160> encoding (Borsh: u32 len + sorted 20-byte entries) ─

export function encodeBTreeSetH160(signers: Uint8Array[]): ReadonlyUint8Array {
  return vec(signers, (s) => Uint8Array.from(s));
}

export function encodeOptionalBTreeSetH160(
  signers: Uint8Array[] | null,
): ReadonlyUint8Array {
  return option(signers, encodeBTreeSetH160);
}

// ── Leaf / Routing / CC fee config ──────────────────────────────────

export interface SvmLeafFeeConfig {
  strategy: SvmFeeDataStrategy;
  signers: Uint8Array[] | null;
}

export function encodeLeafFeeConfig(
  config: SvmLeafFeeConfig,
): ReadonlyUint8Array {
  return concatBytes(
    encodeFeeDataStrategy(config.strategy),
    encodeOptionalBTreeSetH160(config.signers),
  );
}

export interface SvmRoutingFeeConfig {
  wildcardSigners: Uint8Array[];
}

export function encodeRoutingFeeConfig(
  config: SvmRoutingFeeConfig,
): ReadonlyUint8Array {
  return encodeBTreeSetH160(config.wildcardSigners);
}

export interface SvmCrossCollateralRoutingFeeConfig {
  wildcardSigners: Uint8Array[];
}

export function encodeCrossCollateralRoutingFeeConfig(
  config: SvmCrossCollateralRoutingFeeConfig,
): ReadonlyUint8Array {
  return encodeBTreeSetH160(config.wildcardSigners);
}

// ── FeeData enum ────────────────────────────────────────────────────

export type SvmFeeData =
  | { kind: typeof FeeDataKind.Leaf; config: SvmLeafFeeConfig }
  | { kind: typeof FeeDataKind.Routing; config: SvmRoutingFeeConfig }
  | {
      kind: typeof FeeDataKind.CrossCollateralRouting;
      config: SvmCrossCollateralRoutingFeeConfig;
    };

export function encodeFeeData(data: SvmFeeData): ReadonlyUint8Array {
  switch (data.kind) {
    case FeeDataKind.Leaf:
      return concatBytes(u8(data.kind), encodeLeafFeeConfig(data.config));
    case FeeDataKind.Routing:
      return concatBytes(u8(data.kind), encodeRoutingFeeConfig(data.config));
    case FeeDataKind.CrossCollateralRouting:
      return concatBytes(
        u8(data.kind),
        encodeCrossCollateralRoutingFeeConfig(data.config),
      );
  }
}

// ── RouteKey enum (for Add/RemoveQuoteSigner) ───────────────────────

export type SvmRouteKey =
  | { kind: 'domain'; domain: number }
  | {
      kind: 'crossCollateral';
      destination: number;
      targetRouter: Uint8Array;
    };

export function encodeRouteKey(key: SvmRouteKey): ReadonlyUint8Array {
  switch (key.kind) {
    case 'domain':
      return concatBytes(u8(0), u32le(key.domain));
    case 'crossCollateral':
      return concatBytes(
        u8(1),
        u32le(key.destination),
        Uint8Array.from(key.targetRouter),
      );
  }
}

export function encodeOptionalRouteKey(
  key: SvmRouteKey | null,
): ReadonlyUint8Array {
  return option(key, encodeRouteKey);
}

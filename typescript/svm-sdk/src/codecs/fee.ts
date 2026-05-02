import type { ReadonlyUint8Array } from '@solana/kit';

import { FeeDataKind, type FeeStrategyKind } from '../fee/types.js';

import { concatBytes, option, u8, u32le, u64le } from './binary.js';

// ====== Discriminators (8-byte ASCII) ======

export const FEE_ACCT_DISCRIMINATOR = new Uint8Array([
  0x46,
  0x45,
  0x45,
  0x5f,
  0x41,
  0x43,
  0x43,
  0x54, // FEE_ACCT
]);

// ====== Fee Params ======

export interface SvmFeeParams {
  maxFee: bigint;
  halfAmount: bigint;
}

export function encodeFeeParams(params: SvmFeeParams): ReadonlyUint8Array {
  return concatBytes(u64le(params.maxFee), u64le(params.halfAmount));
}

// ====== Fee Data Strategy ======

export type SvmFeeDataStrategy =
  | { kind: typeof FeeStrategyKind.Linear; params: SvmFeeParams }
  | { kind: typeof FeeStrategyKind.Regressive; params: SvmFeeParams }
  | { kind: typeof FeeStrategyKind.Progressive; params: SvmFeeParams };

export function encodeFeeDataStrategy(
  strategy: SvmFeeDataStrategy,
): ReadonlyUint8Array {
  return concatBytes(u8(strategy.kind), encodeFeeParams(strategy.params));
}

// ====== BTreeSet<H160> encoding ======

/**
 * Encodes a list of H160 signers as a Borsh BTreeSet.
 * Sorts lexicographically to match Rust BTreeSet canonical order.
 */
export function encodeBTreeSetH160(signers: Uint8Array[]): ReadonlyUint8Array {
  const sorted = [...signers].sort((a, b) => {
    for (let i = 0; i < 20; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return concatBytes(u32le(sorted.length), ...sorted);
}

// ====== SetQuoteSigner operation ======

export const SetQuoteSignerOp = {
  Add: 0,
  Remove: 1,
} as const;

export type SetQuoteSignerOp =
  (typeof SetQuoteSignerOp)[keyof typeof SetQuoteSignerOp];

export function encodeSetQuoteSignerOperation(
  op: SetQuoteSignerOp,
  signer: Uint8Array,
): ReadonlyUint8Array {
  return concatBytes(u8(op), signer);
}

// ====== Leaf Fee Config ======

export interface SvmLeafFeeConfig {
  strategy: SvmFeeDataStrategy;
  signers: Uint8Array[] | null;
}

export function encodeLeafFeeConfig(
  config: SvmLeafFeeConfig,
): ReadonlyUint8Array {
  return concatBytes(
    encodeFeeDataStrategy(config.strategy),
    option(config.signers, encodeBTreeSetH160),
  );
}

// ====== Fee Data (top-level discriminated union) ======

export type SvmFeeData = {
  kind: typeof FeeDataKind.Leaf;
  config: SvmLeafFeeConfig;
};

export function encodeFeeData(data: SvmFeeData): ReadonlyUint8Array {
  switch (data.kind) {
    case FeeDataKind.Leaf:
      return concatBytes(u8(data.kind), encodeLeafFeeConfig(data.config));

    default: {
      const _exhaustive: never = data.kind;
      throw new Error(`Unhandled FeeData kind: ${_exhaustive}`);
    }
  }
}

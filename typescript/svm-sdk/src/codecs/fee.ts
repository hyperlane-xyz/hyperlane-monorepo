import type { ReadonlyUint8Array } from '@solana/kit';

import { FeeDataKind, type FeeStrategyKind } from '../fee/types.js';

import { concatBytes, u8, u64le } from './binary.js';

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

// ====== Leaf Fee Config ======

export interface SvmLeafFeeConfig {
  strategy: SvmFeeDataStrategy;
  signers: null;
}

export function encodeLeafFeeConfig(
  config: SvmLeafFeeConfig,
): ReadonlyUint8Array {
  return concatBytes(
    encodeFeeDataStrategy(config.strategy),
    u8(0), // Option::None for signers
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

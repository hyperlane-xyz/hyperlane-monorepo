import type { Address } from '@solana/kit';
import { keccak_256 } from '@noble/hashes/sha3';

import type { DeployedFeeAddress } from '@hyperlane-xyz/provider-sdk/fee';

import { addressBytes, ensureLength } from '../codecs/binary.js';
import type { SvmProgramTarget } from '../types.js';

/** Deployed fee artifact data — address is the program, feeAccountPda is the salted PDA. */
export interface SvmDeployedFee extends DeployedFeeAddress {
  programId: Address;
  feeAccountPda: Address;
}

/** Deployment-time configuration for fee writers. */
export type SvmFeeWriterConfig = Readonly<{
  program: SvmProgramTarget;
}>;

/** Zero salt — default for fee deployments (matches H256::zero() in Rust). */
export const DEFAULT_FEE_SALT = new Uint8Array(32);

/** Derive a deterministic salt from a context string (mirrors deriveIgpSalt). */
export function deriveFeeSalt(context: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(context));
}

/**
 * Resolves the fee salt for a given chain.
 *
 * Checks the SVM_FEE_{CHAIN_NAME}_SALT env var. If set, the value is
 * hashed with keccak256 to produce a 32-byte salt. If not set, returns
 * DEFAULT_FEE_SALT (all zeros).
 *
 * This ensures consistency across fee artifact managers and warp writers
 * within the same deployment session without leaking protocol-specific
 * details into the config.
 */
export function resolveFeeSalt(chainName: string): Uint8Array {
  const envKey = `SVM_FEE_${chainName.toUpperCase()}_SALT`;
  const envValue =
    typeof process !== 'undefined' ? process.env[envKey] : undefined;
  if (!envValue) return DEFAULT_FEE_SALT;
  return deriveFeeSalt(envValue);
}

/** On-chain FeeDataStrategy discriminant values. */
export const FeeStrategyKind = {
  Linear: 0,
  Regressive: 1,
  Progressive: 2,
} as const;

export type FeeStrategyKind =
  (typeof FeeStrategyKind)[keyof typeof FeeStrategyKind];

/** On-chain FeeData variant discriminant values. */
export const FeeDataKind = {
  Leaf: 0,
  Routing: 1,
  CrossCollateralRouting: 2,
} as const;

export type FeeDataKind = (typeof FeeDataKind)[keyof typeof FeeDataKind];

/**
 * Convert a hex signer address (0x-prefixed, 20-byte Ethereum address)
 * to a raw 20-byte H160 Uint8Array for on-chain encoding.
 * Validates hex format and exact length.
 */
export function signerToH160(hexAddress: string): Uint8Array {
  return Uint8Array.from(
    ensureLength(addressBytes(hexAddress), 20, 'H160 signer'),
  );
}

/**
 * Convert a raw 20-byte H160 Uint8Array to a 0x-prefixed hex string.
 */
export function h160ToSigner(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

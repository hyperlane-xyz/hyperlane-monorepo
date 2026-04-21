import type { Address } from '@solana/kit';
import { keccak_256 } from '@noble/hashes/sha3';

import type { DeployedFeeAddress } from '@hyperlane-xyz/provider-sdk/fee';

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
 */
export function signerToH160(hexAddress: string): Uint8Array {
  const stripped = hexAddress.startsWith('0x')
    ? hexAddress.slice(2)
    : hexAddress;
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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

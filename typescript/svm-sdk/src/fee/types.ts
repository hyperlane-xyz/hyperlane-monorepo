import type { Address } from '@solana/kit';
import { keccak_256 } from '@noble/hashes/sha3';

import type { DeployedFeeAddress } from '@hyperlane-xyz/provider-sdk/fee';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import type { SvmProgramTarget } from '../types.js';

/** Fee account deployed data — references the program and derived PDA. */
export interface SvmDeployedFee extends DeployedFeeAddress {
  programId: Address;
  feeAccountPda: Address;
}

export type WithWildcardSigners<T> = T & { wildcardSigners: Uint8Array[] };

/** Writer config for fee program — how to obtain the deployed program. */
export type SvmFeeWriterConfig = Readonly<{
  program: SvmProgramTarget;
}>;

/** Zero salt — matches default fee deployments (H256::zero() in Rust). */
export const DEFAULT_FEE_SALT = new Uint8Array(32);

/** Derives a deterministic 32-byte salt from a context string via keccak256. */
export function deriveFeeSalt(context: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(context));
}

/**
 * Resolves fee salt from environment variable or returns default.
 * Checks SVM_FEE_{CHAIN_NAME}_SALT env var → keccak256(value).
 * Chain name is uppercased and non-alphanumeric chars replaced with '_'
 * so names like 'solana-mainnet' produce valid env var 'SVM_FEE_SOLANA_MAINNET_SALT'.
 * Falls back to DEFAULT_FEE_SALT (all zeros).
 */
export function resolveFeeSalt(chainName: string): Uint8Array {
  const sanitized = chainName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const envKey = `SVM_FEE_${sanitized}_SALT`;
  const envValue = process.env[envKey];
  if (envValue) {
    return deriveFeeSalt(envValue);
  }
  return DEFAULT_FEE_SALT;
}

/** Parses a domain ID from a string key, asserting it is a valid non-negative integer. */
export function parseDomainId(domainStr: string): number {
  const domain = Number(domainStr);
  assert(
    Number.isInteger(domain) && domain >= 0,
    `Invalid domain ID: ${domainStr}`,
  );
  return domain;
}

/** On-chain fee strategy curve variants (Borsh variant tags). */
export const FeeStrategyKind = {
  Linear: 0,
  Regressive: 1,
  Progressive: 2,
} as const;

export type FeeStrategyKind =
  (typeof FeeStrategyKind)[keyof typeof FeeStrategyKind];

/** On-chain fee data variants (Borsh variant tags). */
export const FeeDataKind = {
  Leaf: 0,
  Routing: 1,
  CrossCollateralRouting: 2,
} as const;

export type FeeDataKind = (typeof FeeDataKind)[keyof typeof FeeDataKind];

/** Converts a 0x-prefixed hex address to a 20-byte H160 Uint8Array. */
export function signerToH160(hexAddress: string): Uint8Array {
  const hex = strip0x(hexAddress);
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`Expected 40 hex chars for H160, got: ${hexAddress}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Converts a 20-byte H160 Uint8Array to a 0x-prefixed hex string. */
export function h160ToSigner(bytes: Uint8Array): string {
  if (bytes.length !== 20) {
    throw new Error(`Expected 20 bytes for H160, got ${bytes.length}`);
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}`;
}

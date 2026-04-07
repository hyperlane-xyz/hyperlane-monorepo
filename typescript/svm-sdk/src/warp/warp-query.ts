import { type Address, fetchEncodedAccount } from '@solana/kit';

import { assert, fromHexString, toHexString } from '@hyperlane-xyz/utils';

import {
  decodeHyperlaneTokenAccount,
  type HyperlaneTokenAccountData,
} from '../accounts/token.js';
import {
  deriveCrossCollateralStatePda,
  deriveHyperlaneTokenPda,
  deriveNativeCollateralPda,
  deriveSyntheticMintPda,
  deriveEscrowPda,
} from '../pda.js';
import type { SvmRpc } from '../types.js';

export enum SvmWarpTokenType {
  Native = 'native',
  Synthetic = 'synthetic',
  Collateral = 'collateral',
  CrossCollateral = 'crossCollateral',
}

/**
 * Fetches and decodes the HyperlaneToken PDA for a given warp program.
 * Returns null if the account does not exist or is not initialized.
 */
export async function fetchTokenAccount(
  rpc: SvmRpc,
  programId: Address,
): Promise<HyperlaneTokenAccountData | null> {
  const { address: tokenPda } = await deriveHyperlaneTokenPda(programId);
  const account = await fetchEncodedAccount(rpc, tokenPda);
  if (!account.exists) return null;
  return decodeHyperlaneTokenAccount(account.data as Uint8Array);
}

/**
 * Detects the warp token type by checking which type-specific PDA exists on-chain.
 *
 * Each token type creates exactly one unique PDA during init:
 *   Native:     nativeCollateralPda  ["hyperlane_token", "-", "native_collateral"]
 *   Synthetic:  syntheticMintPda     ["hyperlane_token", "-", "mint"]
 *   Collateral: escrowPda            ["hyperlane_token", "-", "escrow"]
 */
export async function detectWarpTokenType(
  rpc: SvmRpc,
  programId: Address,
): Promise<SvmWarpTokenType> {
  const [
    { address: nativeCollateralPda },
    { address: syntheticMintPda },
    { address: escrowPda },
    { address: ccStatePda },
  ] = await Promise.all([
    deriveNativeCollateralPda(programId),
    deriveSyntheticMintPda(programId),
    deriveEscrowPda(programId),
    deriveCrossCollateralStatePda(programId),
  ]);

  const [nativeAccount, syntheticAccount, collateralAccount, ccStateAccount] =
    await Promise.all([
      fetchEncodedAccount(rpc, nativeCollateralPda),
      fetchEncodedAccount(rpc, syntheticMintPda),
      fetchEncodedAccount(rpc, escrowPda),
      fetchEncodedAccount(rpc, ccStatePda),
    ]);

  // CC has both escrow + CC state; check CC first to disambiguate from collateral
  if (collateralAccount.exists && ccStateAccount.exists) {
    return SvmWarpTokenType.CrossCollateral;
  }

  const matches: SvmWarpTokenType[] = [];
  if (nativeAccount.exists) matches.push(SvmWarpTokenType.Native);
  if (syntheticAccount.exists) matches.push(SvmWarpTokenType.Synthetic);
  if (collateralAccount.exists) matches.push(SvmWarpTokenType.Collateral);

  assert(
    matches.length === 1,
    matches.length === 0
      ? `Unable to detect warp token type for program ${programId}: no type-specific PDA found`
      : `Ambiguous warp token type for program ${programId}: multiple type-specific PDAs exist (${matches.join(', ')})`,
  );

  const result = matches[0];
  assert(result !== undefined, 'Unexpected empty matches after validation');
  return result;
}

/** Converts a 32-byte router H256 to a 0x-prefixed hex string. */
export function routerBytesToHex(bytes: Uint8Array): string {
  return toHexString(Buffer.from(bytes));
}

/**
 * Converts a 0x-prefixed hex string to a 32-byte Uint8Array.
 * Asserts the result is exactly 32 bytes.
 */
export function routerHexToBytes(hex: string): Uint8Array {
  const bytes = fromHexString(hex);
  assert(
    bytes.length === 32,
    `Router address must be 32 bytes (64 hex chars), got ${bytes.length}`,
  );
  return bytes;
}

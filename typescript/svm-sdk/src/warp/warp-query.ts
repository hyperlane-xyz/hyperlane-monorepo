import { type Address, fetchEncodedAccount } from '@solana/kit';

import { assert, fromHexString, toHexString } from '@hyperlane-xyz/utils';

import {
  decodeHyperlaneTokenAccount,
  type HyperlaneTokenAccountData,
} from '../accounts/token.js';
import { deriveHyperlaneTokenPda } from '../pda.js';
import type { SvmRpc } from '../types.js';

export enum SvmWarpTokenType {
  Native = 'native',
  Synthetic = 'synthetic',
  Collateral = 'collateral',
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
 * Detects the warp token type by inspecting the pluginData length.
 *
 * Sizes:
 *   NativePlugin    = 1 byte  (native_collateral_bump)
 *   SyntheticPlugin = 34 bytes (mint:32 + mint_bump:1 + ata_payer_bump:1)
 *   CollateralPlugin = 98 bytes (spl_token_program:32 + mint:32 + escrow:32 + escrow_bump:1 + ata_payer_bump:1)
 */
export async function detectWarpTokenType(
  rpc: SvmRpc,
  programId: Address,
): Promise<SvmWarpTokenType> {
  const token = await fetchTokenAccount(rpc, programId);
  assert(
    token !== null,
    `Token account not initialized at program ${programId}`,
  );

  const len = token.pluginData.length;
  if (len === 1) return SvmWarpTokenType.Native;
  // Current SyntheticPlugin: 34 bytes (mint:32 + mint_bump:1 + ata_payer_bump:1).
  // Legacy SyntheticPlugin: 66 bytes (mint:32 + ata_payer:32 + mint_bump:1 + ata_payer_bump:1).
  // decodeSyntheticPlugin reads only the first 34 bytes in both cases.
  if (len === 34 || len === 66) return SvmWarpTokenType.Synthetic;
  if (len >= 98) return SvmWarpTokenType.Collateral;

  throw new Error(
    `Unable to detect warp token type for program ${programId}: unexpected pluginData length ${len}`,
  );
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

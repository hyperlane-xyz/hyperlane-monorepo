import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';

import { type Igp, fetchMaybeIgp } from '../generated/accounts/igp.js';
import {
  type OverheadIgp,
  fetchMaybeOverheadIgp,
} from '../generated/accounts/overheadIgp.js';
import {
  type ProgramData,
  fetchMaybeProgramData,
} from '../generated/accounts/programData.js';
import {
  getIgpAccountPda,
  getIgpProgramDataPda,
  getOverheadIgpAccountPda,
} from '../pda.js';

/**
 * Fetches IGP program data (global state) from chain.
 *
 * @param rpc - Solana RPC client
 * @param programId - IGP program ID
 * @returns ProgramData or null if not initialized
 */
export async function fetchIgpProgramData(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<ProgramData | null> {
  const [programDataPda] = await getIgpProgramDataPda(programId);
  const account = await fetchMaybeProgramData(rpc, programDataPda);
  return account.exists ? account.data : null;
}

/**
 * Fetches an IGP account by salt.
 *
 * @param rpc - Solana RPC client
 * @param programId - IGP program ID
 * @param salt - 32-byte salt (typically keccak256 of context string)
 * @returns Igp account data or null if not exists
 */
export async function fetchIgpAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  salt: Uint8Array,
): Promise<Igp | null> {
  const [igpPda] = await getIgpAccountPda(programId, salt);
  const account = await fetchMaybeIgp(rpc, igpPda);
  return account.exists ? account.data : null;
}

/**
 * Fetches an Overhead IGP account by salt.
 *
 * @param rpc - Solana RPC client
 * @param programId - IGP program ID
 * @param salt - 32-byte salt (typically keccak256 of context string)
 * @returns OverheadIgp account data or null if not exists
 */
export async function fetchOverheadIgpAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  salt: Uint8Array,
): Promise<OverheadIgp | null> {
  const [overheadIgpPda] = await getOverheadIgpAccountPda(programId, salt);
  const account = await fetchMaybeOverheadIgp(rpc, overheadIgpPda);
  return account.exists ? account.data : null;
}

/**
 * Detects hook type.
 *
 * On Solana, hooks are program-based. The main types are:
 * - IGP (interchainGasPaymaster)
 * - MerkleTree (built into mailbox)
 *
 * @param rpc - Solana RPC client
 * @param address - Hook address (program ID or mailbox for merkle tree)
 * @returns Detected hook type
 */
export async function detectHookType(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<HookType> {
  // Check for IGP program data
  const igpProgramData = await fetchIgpProgramData(rpc, address);
  if (igpProgramData !== null) {
    return HookType.INTERCHAIN_GAS_PAYMASTER;
  }

  // On Solana, merkle tree is part of mailbox, so detection is done by
  // checking if it's a mailbox address. For now, if it's not IGP, assume merkle.
  // This is a simplification - proper detection would need mailbox program info.
  return HookType.MERKLE_TREE;
}

/**
 * Converts remote gas data from on-chain format to readable format.
 */
export function remoteGasDataToConfig(gasOracle: {
  __kind: 'RemoteGasData';
  fields: readonly [
    {
      tokenExchangeRate: bigint;
      gasPrice: bigint;
      tokenDecimals: number;
    },
  ];
}): {
  gasPrice: string;
  tokenExchangeRate: string;
  tokenDecimals: number;
} {
  const data = gasOracle.fields[0];
  return {
    gasPrice: data.gasPrice.toString(),
    tokenExchangeRate: data.tokenExchangeRate.toString(),
    tokenDecimals: data.tokenDecimals,
  };
}

import { type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';

import {
  decodeIgpAccount,
  decodeIgpProgramDataAccount,
  decodeOverheadIgpAccount,
  type IgpAccountData,
  type IgpProgramData,
  type OverheadIgpAccountData,
} from '../accounts/token.js';
import {
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveOverheadIgpAccountPda,
} from '../pda.js';
import { fetchAccountDataRaw } from '../rpc.js';
import { queryProgramVersionWithOwnerFallback } from '../version/version-query.js';

export const decodeHookAccount = {
  igpProgramData: decodeIgpProgramDataAccount,
  igp: decodeIgpAccount,
  overheadIgp: decodeOverheadIgpAccount,
};

export async function fetchIgpProgramData(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<IgpProgramData | null> {
  const { address: programDataPda } = await deriveIgpProgramDataPda(programId);
  const raw = await fetchAccountDataRaw(rpc, programDataPda);
  if (!raw || raw.length === 0) return null;
  return decodeIgpProgramDataAccount(raw);
}

export async function fetchIgpAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  salt: Uint8Array,
): Promise<IgpAccountData | null> {
  const { address: igpPda } = await deriveIgpAccountPda(programId, salt);
  const raw = await fetchAccountDataRaw(rpc, igpPda);
  if (!raw || raw.length === 0) return null;
  return decodeIgpAccount(raw);
}

export async function fetchOverheadIgpAccount(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  salt: Uint8Array,
): Promise<OverheadIgpAccountData | null> {
  const { address: overheadIgpPda } = await deriveOverheadIgpAccountPda(
    programId,
    salt,
  );
  const raw = await fetchAccountDataRaw(rpc, overheadIgpPda);
  if (!raw || raw.length === 0) return null;
  return decodeOverheadIgpAccount(raw);
}

/**
 * Queries the on-chain program version for an IGP program.
 *
 * Uses the IGP owner as the simulation fee payer when present, falling
 * back to a known-funded mainnet address when the owner is null or the
 * owner-paid simulation fails (e.g. production owner has no SOL).
 * Returns null when both attempts fail (e.g. fallback payer absent on
 * this chain), so reads remain best-effort.
 */
export async function fetchIgpProgramVersion(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
  owner: Address | null,
): Promise<string | null> {
  return queryProgramVersionWithOwnerFallback(rpc, programId, owner);
}

export async function detectHookType(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<HookType | null> {
  const igpProgramData = await fetchIgpProgramData(rpc, address);
  if (igpProgramData !== null) {
    return HookType.INTERCHAIN_GAS_PAYMASTER;
  }
  return null;
}

export function remoteGasDataToConfig(gasOracle: {
  kind: 0;
  value: {
    tokenExchangeRate: bigint;
    gasPrice: bigint;
    tokenDecimals: number;
  };
}): {
  gasPrice: string;
  tokenExchangeRate: string;
  tokenDecimals: number;
} {
  const data = gasOracle.value;
  return {
    gasPrice: data.gasPrice.toString(),
    tokenExchangeRate: data.tokenExchangeRate.toString(),
    tokenDecimals: data.tokenDecimals,
  };
}

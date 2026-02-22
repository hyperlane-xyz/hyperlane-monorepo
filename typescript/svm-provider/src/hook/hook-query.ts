import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  fetchEncodedAccount,
} from '@solana/kit';

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

export const decodeHookAccount = {
  igpProgramData: decodeIgpProgramDataAccount,
  igp: decodeIgpAccount,
  overheadIgp: decodeOverheadIgpAccount,
};

async function fetchAccountDataRaw(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<Uint8Array | null> {
  const maybeAccount = await fetchEncodedAccount(rpc, address, {
    commitment: 'confirmed',
  });
  if (!maybeAccount.exists) return null;
  return maybeAccount.data;
}

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

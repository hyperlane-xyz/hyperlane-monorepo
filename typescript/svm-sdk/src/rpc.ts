import {
  type Address,
  type MaybeEncodedAccount,
  type Rpc,
  type SolanaRpcApi,
  createSolanaRpc,
  fetchEncodedAccount,
} from '@solana/kit';

export function createRpc(url: string): Rpc<SolanaRpcApi> {
  return createSolanaRpc(url);
}

// Returns MaybeEncodedAccount to preserve Kit's explicit existence-check shape.
// Callers should branch on .exists or use assertAccountExists().
export async function fetchAccount(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<MaybeEncodedAccount> {
  return fetchEncodedAccount(rpc, address);
}

/**
 * Fetches raw account data bytes, returning null when the account does not exist.
 */
export async function fetchAccountDataRaw(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<Uint8Array | null> {
  const maybeAccount = await fetchEncodedAccount(rpc, address, {
    commitment: 'confirmed',
  });
  if (!maybeAccount.exists) return null;
  return maybeAccount.data;
}

export type SolanaRpcClient = Rpc<SolanaRpcApi>;

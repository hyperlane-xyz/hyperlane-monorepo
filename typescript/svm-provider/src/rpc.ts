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

export type SolanaRpcClient = Rpc<SolanaRpcApi>;

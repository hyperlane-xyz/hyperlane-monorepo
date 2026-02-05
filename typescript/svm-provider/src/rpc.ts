import {
  type Address,
  type EncodedAccount,
  type MaybeEncodedAccount,
  type Rpc,
  type SolanaRpcApi,
  createSolanaRpc,
  fetchEncodedAccount,
} from '@solana/kit';

/**
 * Creates a Solana RPC client for the given URL.
 */
export function createRpc(url: string): Rpc<SolanaRpcApi> {
  return createSolanaRpc(url);
}

/**
 * Fetches an account from the chain, returning null if it doesn't exist.
 */
export async function fetchAccount(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<EncodedAccount | null> {
  const maybeAccount: MaybeEncodedAccount = await fetchEncodedAccount(
    rpc,
    address,
  );
  return maybeAccount.exists ? maybeAccount : null;
}

/**
 * RPC type alias for convenience.
 */
export type SolanaRpc = Rpc<SolanaRpcApi>;

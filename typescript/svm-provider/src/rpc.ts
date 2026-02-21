import {
  type Address,
  type EncodedAccount,
  type MaybeEncodedAccount,
  type Rpc,
  type SolanaRpcApi,
  createSolanaRpc,
  fetchEncodedAccount,
} from '@solana/kit';

export function createRpc(url: string): Rpc<SolanaRpcApi> {
  return createSolanaRpc(url);
}

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

export type SolanaRpcClient = Rpc<SolanaRpcApi>;

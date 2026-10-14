import {
  type Address,
  type MaybeEncodedAccount,
  type Rpc,
  type SolanaRpcApi,
  createSolanaRpc,
  fetchEncodedAccount,
  fetchEncodedAccounts,
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

// getMultipleAccounts rejects requests for more than 100 accounts.
const MAX_MULTIPLE_ACCOUNTS = 100;

/** The result is aligned with `addresses`; null for accounts that do not exist. */
export async function fetchAccountDataRawBatch(
  rpc: Rpc<SolanaRpcApi>,
  addresses: readonly Address[],
): Promise<(Uint8Array | null)[]> {
  const out: (Uint8Array | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_MULTIPLE_ACCOUNTS) {
    const accounts = await fetchEncodedAccounts(
      rpc,
      addresses.slice(i, i + MAX_MULTIPLE_ACCOUNTS),
      { commitment: 'confirmed' },
    );
    for (const account of accounts) {
      out.push(account.exists ? account.data : null);
    }
  }
  return out;
}

export type SolanaRpcClient = Rpc<SolanaRpcApi>;

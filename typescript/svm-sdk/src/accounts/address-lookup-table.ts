import { fetchAddressLookupTable } from '@solana-program/address-lookup-table';
import type { Address } from '@solana/kit';

import type { SvmRpc } from '../types.js';

/**
 * Decoded address-lookup-table account state, normalized for SDK use:
 * the on-chain `Option<authority>` field is collapsed into a nullable
 * `owner` (null when the table is frozen).
 */
export interface AddressLookupTableState {
  /** Authority allowed to extend / freeze the table. `null` when frozen. */
  owner: Address | null;
  /** Addresses stored in the table, in on-chain index order. */
  addresses: Address[];
  /** Slot at which the last extend operation landed. */
  lastExtendedSlot: bigint;
}

/**
 * Reads the on-chain address-lookup table at `address` and returns its
 * normalized state. Use the `addresses` field as input to
 * `buildTransactionMessage({ addressLookupTables })`.
 */
export async function fetchAddressLookupTableState(
  rpc: SvmRpc,
  address: Address,
): Promise<AddressLookupTableState> {
  const account = await fetchAddressLookupTable(rpc, address);
  const authority = account.data.authority;
  return {
    owner: authority.__option === 'Some' ? authority.value : null,
    addresses: [...account.data.addresses],
    lastExtendedSlot: account.data.lastExtendedSlot,
  };
}

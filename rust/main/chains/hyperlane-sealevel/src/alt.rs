//! Address Lookup Table (ALT) support for Sealevel transactions.
//!
//! ALTs are optional and help reduce transaction size by allowing accounts to be
//! referenced by a 1-byte index rather than a 32-byte pubkey. This is particularly
//! useful for Hyperlane process transactions which have many accounts.
//!
//! When an ALT is configured for a chain (via `mailboxProcessAlt` in chain config):
//! - The mailbox includes the ALT address in the process payload
//! - The provider lazily loads the ALT and uses VersionedTransaction with V0 message
//!
//! When no ALT is configured:
//! - Legacy Transaction format is used (compatible with all SVM chains)
//!
//! ALTs are assumed to be static once created. The provider caches loaded ALTs
//! indefinitely.

use hyperlane_core::{ChainCommunicationError, ChainResult};
use solana_address_lookup_table_program::state::AddressLookupTable;
use solana_program::address_lookup_table_account::AddressLookupTableAccount;
use solana_sdk::pubkey::Pubkey;

use crate::rpc::fallback::SealevelFallbackRpcClient;

/// Load an ALT from the chain into the Solana SDK's native type.
///
/// This fetches the ALT account data and deserializes it into an `AddressLookupTableAccount`
/// which can be used directly with `MessageV0::try_compile`.
pub async fn load_alt(
    rpc: &SealevelFallbackRpcClient,
    alt_address: Pubkey,
) -> ChainResult<AddressLookupTableAccount> {
    let account = rpc
        .get_account_with_finalized_commitment(alt_address)
        .await?;
    let alt = AddressLookupTable::deserialize(&account.data)
        .map_err(ChainCommunicationError::from_other)?;
    Ok(AddressLookupTableAccount {
        key: alt_address,
        addresses: alt.addresses.to_vec(),
    })
}

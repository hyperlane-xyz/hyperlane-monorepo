//! Address Lookup Table (ALT) support for Sealevel transactions.
//!
//! ALTs are optional and help reduce transaction size by allowing accounts to be
//! referenced by a 1-byte index rather than a 32-byte pubkey. This is particularly
//! useful for Hyperlane process transactions which have many accounts.
//!
//! When an ALT is available for a domain:
//! - The mailbox includes the ALT address in the process payload
//! - The provider lazily loads the ALT and uses VersionedTransaction with V0 message
//!
//! When no ALT is available:
//! - Legacy Transaction format is used (compatible with all SVM chains)
//!
//! ALTs are assumed to be static once created. The provider caches loaded ALTs
//! indefinitely.

use hyperlane_core::{ChainCommunicationError, ChainResult, HyperlaneDomain, KnownHyperlaneDomain};
use solana_address_lookup_table_program::state::AddressLookupTable;
use solana_program::address_lookup_table_account::AddressLookupTableAccount;
use solana_sdk::pubkey::Pubkey;

use crate::rpc::fallback::SealevelFallbackRpcClient;

/// ALT for Solana mainnet containing common Hyperlane accounts:
/// - System Program, Inbox PDA, SPL Noop
/// - Token Program, Token 2022, ATA Program (CPI targets)
///
/// Created via: hyperlane-sealevel-client alt create --mailbox-program-id E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi
pub const SOLANA_MAINNET_ALT: Pubkey =
    solana_sdk::pubkey!("5iPyGCTQ2xHaCxv9A8GDJzt2tHWL8t9FK8UwG3KoQsYo");

/// ALT for Solana testnet containing common Hyperlane accounts.
pub const SOLANA_TESTNET_ALT: Pubkey =
    solana_sdk::pubkey!("HuStn3Dtk2Zod1FzUoC19tjXE987WbTbD988ABD52BGq");

/// Get the ALT address for a given domain, if one exists.
///
/// Only domains with pre-deployed ALTs return Some. Other SVM chains (e.g. Solaxy)
/// will use legacy transactions instead.
pub fn get_alt_for_domain(domain: &HyperlaneDomain) -> Option<Pubkey> {
    match domain {
        HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaMainnet) => Some(SOLANA_MAINNET_ALT),
        HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaTestnet) => Some(SOLANA_TESTNET_ALT),
        _ => None,
    }
}

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

//! Address Lookup Table (ALT) support for Sealevel transactions.
//!
//! ALTs reduce transaction size by allowing accounts to be referenced by index
//! rather than by full 32-byte pubkey.

use hyperlane_core::{ChainCommunicationError, ChainResult, HyperlaneDomain, KnownHyperlaneDomain};
use solana_address_lookup_table_program::state::AddressLookupTable;
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
pub fn get_alt_for_domain(domain: &HyperlaneDomain) -> Option<Pubkey> {
    match domain {
        HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaMainnet) => Some(SOLANA_MAINNET_ALT),
        HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaTestnet) => Some(SOLANA_TESTNET_ALT),
        _ => None,
    }
}

/// Cache for an Address Lookup Table's contents.
#[derive(Debug, Clone)]
pub struct AddressLookupTableCache {
    /// The ALT's on-chain address.
    pub address: Pubkey,
    /// The accounts stored in the ALT.
    pub accounts: Vec<Pubkey>,
}

impl AddressLookupTableCache {
    /// Load an ALT from the chain.
    pub async fn load(rpc: &SealevelFallbackRpcClient, alt_address: &Pubkey) -> ChainResult<Self> {
        let account = rpc
            .get_account_with_finalized_commitment(*alt_address)
            .await?;
        let alt = AddressLookupTable::deserialize(&account.data)
            .map_err(ChainCommunicationError::from_other)?;
        Ok(Self {
            address: *alt_address,
            accounts: alt.addresses.to_vec(),
        })
    }

    /// Find the index of a pubkey in the ALT, if it exists.
    #[allow(dead_code)]
    pub fn find_index(&self, pubkey: &Pubkey) -> Option<u8> {
        self.accounts
            .iter()
            .position(|p| p == pubkey)
            .and_then(|i| u8::try_from(i).ok())
    }
}

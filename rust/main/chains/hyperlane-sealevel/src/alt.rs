//! Address Lookup Table (ALT) support for Sealevel transactions.
//!
//! ALTs are optional and help reduce transaction size by allowing accounts to be
//! referenced by a 1-byte index rather than a 32-byte pubkey. This is particularly
//! useful for Hyperlane process transactions which have many accounts.
//!
//! When ALTs are configured for a chain (via `mailboxProcessAlts`, or the legacy
//! singular `mailboxProcessAlt`, in chain config):
//! - The mailbox includes the ALT addresses in the process payload
//! - The provider lazily fetches the ALTs and uses VersionedTransaction with a V0 message
//!
//! When no ALT is configured:
//! - Legacy Transaction format is used (compatible with all SVM chains)
//!
//! ALTs are assumed to be static once created. The provider caches fetched ALTs
//! indefinitely.

use std::sync::Arc;

use hyperlane_core::{ChainCommunicationError, ChainResult};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use solana_address_lookup_table_interface::state::AddressLookupTable;
use solana_sdk::message::AddressLookupTableAccount;
use solana_sdk::pubkey::Pubkey;

use crate::rpc::fallback::SealevelFallbackRpcClient;

/// A non-empty, immutable collection of ALT addresses.
///
/// The private shared slice enforces non-emptiness after construction and makes
/// cloning cheap when the same configuration crosses asynchronous layers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NonEmptyAltAddresses(Arc<[Pubkey]>);

impl NonEmptyAltAddresses {
    /// Returns the ALT addresses in transaction compile order.
    pub fn as_slice(&self) -> &[Pubkey] {
        &self.0
    }
}

impl TryFrom<Vec<Pubkey>> for NonEmptyAltAddresses {
    type Error = EmptyAltAddresses;

    fn try_from(addresses: Vec<Pubkey>) -> Result<Self, Self::Error> {
        if addresses.is_empty() {
            Err(EmptyAltAddresses)
        } else {
            Ok(Self(addresses.into()))
        }
    }
}

impl From<Pubkey> for NonEmptyAltAddresses {
    fn from(address: Pubkey) -> Self {
        Self(Arc::from([address]))
    }
}

/// Error returned when constructing a non-empty ALT collection from no addresses.
#[derive(Debug, thiserror::Error)]
#[error("address lookup table list cannot be empty")]
pub struct EmptyAltAddresses;

/// Selects the Solana transaction representation explicitly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SealevelTransactionFormat {
    /// Build a legacy transaction without ALTs.
    #[default]
    Legacy,
    /// Build a versioned transaction with at least one ALT.
    V0 {
        /// ALT addresses in transaction compile order.
        alt_addresses: NonEmptyAltAddresses,
    },
}

impl Serialize for SealevelTransactionFormat {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Legacy => serializer.serialize_none(),
            Self::V0 { alt_addresses } => alt_addresses.as_slice().serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for SealevelTransactionFormat {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::Error as _;

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum PersistedAddressLookupTables {
            Many(Vec<Pubkey>),
            One(Option<Pubkey>),
        }

        match PersistedAddressLookupTables::deserialize(deserializer)? {
            PersistedAddressLookupTables::Many(addresses) => {
                NonEmptyAltAddresses::try_from(addresses)
                    .map(|alt_addresses| Self::V0 { alt_addresses })
                    .map_err(D::Error::custom)
            }
            PersistedAddressLookupTables::One(Some(address)) => Ok(Self::V0 {
                alt_addresses: address.into(),
            }),
            PersistedAddressLookupTables::One(None) => Ok(Self::Legacy),
        }
    }
}

/// Fetch an ALT from the chain into the Solana SDK's native type.
///
/// This fetches the ALT account data and deserializes it into an `AddressLookupTableAccount`
/// which can be used directly with `MessageV0::try_compile`.
pub async fn fetch_alt(
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

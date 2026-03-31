use std::{fmt::Debug, ops::Deref};

use async_trait::async_trait;
use auto_impl::auto_impl;
use borsh::{BorshDeserialize, BorshSerialize};
use derive_new::new;
use hex::FromHex;
use num_derive::FromPrimitive;
use serde::{Deserialize, Serialize};

use crate::{ChainResult, HyperlaneContract, HyperlaneMessage, U256};

/// Enumeration of all known module types
#[derive(
    FromPrimitive,
    Clone,
    Debug,
    Default,
    Copy,
    Hash,
    PartialEq,
    Eq,
    BorshDeserialize,
    BorshSerialize,
    Serialize,
    Deserialize,
)]
#[cfg_attr(feature = "strum", derive(strum::Display))]
pub enum ModuleType {
    /// INVALID ISM
    #[default]
    Unused,
    /// Routing ISM (defers to another ISM)
    Routing,
    /// Aggregation ISM (aggregates multiple ISMs)
    Aggregation,
    /// Legacy ISM (DEPRECATED)
    LegacyMultisig,
    /// Merkle Proof ISM (batching and censorship resistance)
    MerkleRootMultisig,
    /// Message ID ISM (cheapest multisig with no batching)
    MessageIdMultisig,
    /// No metadata ISM (no metadata)
    Null,
    /// Ccip Read ISM (accepts offchain signature information)
    CcipRead,
}

/// Metadata associated with an ISM verification
#[derive(Clone, PartialEq, Eq, new)]
pub struct Metadata(Vec<u8>);

impl Metadata {
    /// Returns a owned Vec<u8>
    pub fn to_owned(&self) -> Vec<u8> {
        self.0.to_vec()
    }
}

impl AsRef<[u8]> for Metadata {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl Deref for Metadata {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl FromHex for Metadata {
    type Error = hex::FromHexError;

    fn from_hex<T: AsRef<[u8]>>(hex: T) -> Result<Self, Self::Error> {
        let bytes = Vec::from_hex(hex)?;
        Ok(Metadata(bytes))
    }
}

impl Debug for Metadata {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Metadata(0x{})", hex::encode(&self.0))
    }
}

impl ModuleType {
    /// as a str
    pub const fn as_str(&self) -> &str {
        match self {
            Self::Unused => "invalid",
            Self::Routing => "routing",
            Self::Aggregation => "aggregation",
            Self::LegacyMultisig => "legacy_multisig",
            Self::MerkleRootMultisig => "merkle_root_multisig",
            Self::MessageIdMultisig => "message_id_multisig",
            Self::Null => "null",
            Self::CcipRead => "ccip_read",
        }
    }
}

/// Interface for the InterchainSecurityModule chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait InterchainSecurityModule: HyperlaneContract + Send + Sync + Debug {
    /// Returns the module type of the ISM compliant with the corresponding
    /// metadata offchain fetching and onchain formatting standard.
    async fn module_type(&self) -> ChainResult<ModuleType>;

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<Option<U256>>;
}

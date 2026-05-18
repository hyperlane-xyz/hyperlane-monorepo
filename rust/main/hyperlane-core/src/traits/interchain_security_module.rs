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
///
/// Discriminants must match the Solidity IInterchainSecurityModule.Types enum exactly so that
/// on-chain values round-trip correctly through FromPrimitive.  Borsh serialisation is keyed on
/// the discriminant (use_discriminant = true) for the same reason.  Never reorder variants or
/// change values; append new Solidity types at the end of their numeric sequence and put
/// Sealevel-only types above 127.
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
#[borsh(use_discriminant = true)]
pub enum ModuleType {
    /// INVALID ISM
    #[default]
    Unused = 0,
    /// Routing ISM (defers to another ISM)
    Routing = 1,
    /// Aggregation ISM (aggregates multiple ISMs)
    Aggregation = 2,
    /// Legacy ISM (DEPRECATED)
    LegacyMultisig = 3,
    /// Merkle Proof ISM (batching and censorship resistance)
    MerkleRootMultisig = 4,
    /// Message ID ISM (cheapest multisig with no batching)
    MessageIdMultisig = 5,
    /// No metadata ISM (no metadata)
    Null = 6,
    /// Ccip Read ISM (accepts offchain signature information)
    CcipRead = 7,
    /// Arbitrum L2→L1 native bridge ISM
    ArbL2ToL1 = 8,
    /// Weighted Merkle Root multisig ISM
    WeightedMerkleRootMultisig = 9,
    /// Weighted Message ID multisig ISM
    WeightedMessageIdMultisig = 10,
    /// Optimism L2→L1 native bridge ISM
    OpL2ToL1 = 11,
    /// Polymer IBC ISM
    Polymer = 12,
    /// Composite ISM (Sealevel inline ISM tree) — Sealevel-only, no Solidity counterpart
    Composite = 13,
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
            Self::ArbL2ToL1 => "arb_l2_to_l1",
            Self::WeightedMerkleRootMultisig => "weighted_merkle_root_multisig",
            Self::WeightedMessageIdMultisig => "weighted_message_id_multisig",
            Self::OpL2ToL1 => "op_l2_to_l1",
            Self::Polymer => "polymer",
            Self::Composite => "composite",
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

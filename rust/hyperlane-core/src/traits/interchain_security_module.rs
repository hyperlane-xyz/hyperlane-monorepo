use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use num_derive::FromPrimitive;
use primitive_types::U256;
use strum::Display;

use crate::{ChainResult, HyperlaneContract, HyperlaneMessage};

/// Enumeration of all known module types
#[derive(FromPrimitive, Clone, Debug, Default, Display, Copy, PartialEq, Eq)]
pub enum ModuleType {
    /// INVALID ISM
    #[default]
    Unused,
    /// Routing ISM (defers to another ISM)
    Routing,
    /// Aggregation ISM (aggregates multiple ISMs)
    Aggregation,
    /// Legacy ISM (validators in calldata, set commitment in storage)
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
        metadata: &[u8],
    ) -> ChainResult<Option<U256>>;
}

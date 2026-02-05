//! Type definitions for the Mailbox program.

use borsh::{BorshDeserialize, BorshSerialize};
use shank::ShankType;

/// Proxy struct for IncrementalMerkle from hyperlane_core.
/// This tells Shank to import the type definition from the external library's IDL
/// instead of duplicating the fields here.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq, ShankType)]
#[shank(import_from = "hyperlane_core", rename = "IncrementalMerkle")]
pub struct MerkleTreeProxy;

// Re-export the real type for use in the program logic
pub use hyperlane_core::accumulator::incremental::IncrementalMerkle as MerkleTree;

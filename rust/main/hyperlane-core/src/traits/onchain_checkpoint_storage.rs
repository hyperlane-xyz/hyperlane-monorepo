use crate::HyperlaneContract;
use std::fmt::Debug;

/// Interface for Checkpoint storage onchain, implemented in each chain's folder
pub trait OnchainCheckpointStorage: HyperlaneContract + Debug + Send + Sync {
    /// Return the on chain location of the checkpoint storage
    fn announcement_location(&self) -> String;
}

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{Announcement, ChainResult, HyperlaneContract, SignedType, TxOutcome, H256, U256};

/// Interface for the ValidatorAnnounce chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait ValidatorAnnounce: HyperlaneContract + Send + Sync + Debug {
    /// Returns the announced storage locations for the provided validators.
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>>;

    /// Announce a storage location for a validator
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome>;

    /// Returns the number of additional tokens needed to pay for the announce
    /// transaction. Return `None` if the needed tokens cannot be determined.
    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        chain_signer: H256,
    ) -> Option<U256>;
}

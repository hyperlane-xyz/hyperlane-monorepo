use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    Announcement, ChainCommunicationError, ChainResult, HyperlaneContract, SignedType, TxOutcome,
    H256, H512, U256,
};

/// The stage reached by a validator announcement submission.
#[derive(Debug)]
pub enum ValidatorAnnounceSubmission {
    /// The transaction was confirmed on-chain.
    Confirmed(TxOutcome),
    /// The transaction was broadcast, but receipt tracking failed afterwards.
    /// The original error is retained for operator observability.
    BroadcastError {
        /// The hash returned by the initial broadcast.
        tx_id: H512,
        /// The error encountered while tracking the broadcast transaction.
        error: ChainCommunicationError,
    },
}

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

    /// Announce a storage location while preserving whether an error happened before or after
    /// the transaction was successfully broadcast.
    async fn announce_with_status(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<ValidatorAnnounceSubmission> {
        self.announce(announcement)
            .await
            .map(ValidatorAnnounceSubmission::Confirmed)
    }

    /// Returns the number of additional tokens needed to pay for the announce
    /// transaction. Return `None` if the needed tokens cannot be determined.
    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        chain_signer: H256,
    ) -> Option<U256>;
}

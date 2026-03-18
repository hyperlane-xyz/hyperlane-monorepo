//! An Indexer provides a common interface for bubbling up chain-specific
//! event-data to another entity (e.g. a `ContractSync`). For example, the only
//! way to retrieve data such as the chain's latest block number or a list of
//! checkpoints/messages emitted within a certain block range by calling out to
//! a chain-specific library and provider (e.g. ethers::provider).

use std::fmt::Debug;
use std::ops::RangeInclusive;

use async_trait::async_trait;
use auto_impl::auto_impl;
use serde::Deserialize;

use crate::{ChainResult, Indexed, LogMeta, H512};

/// Indexing mode.
#[derive(Copy, Debug, Default, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum IndexMode {
    /// Block based indexing.
    #[default]
    Block,
    /// Sequence based indexing.
    Sequence,
}

/// Interface for an indexer.
#[async_trait]
#[auto_impl(&, Box, Arc,)]
pub trait Indexer<T: Sized>: Send + Sync + Debug {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>;

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;

    /// Parse protocol-specific transaction hash string to H512.
    /// Default implementation handles hex-encoded hashes (EVM, Cosmos, Tron, Radix).
    /// Override for chains with different formats (e.g., base58 for Solana).
    fn parse_tx_hash(&self, tx_hash: &str) -> ChainResult<H512> {
        use crate::ChainCommunicationError;

        let tx_hash_clean = tx_hash.trim_start_matches("0x");
        let hash_bytes = hex::decode(tx_hash_clean).map_err(|e| {
            ChainCommunicationError::from_other_str(&format!("Invalid hex tx hash: {e}"))
        })?;

        if hash_bytes.len() > 64 {
            return Err(ChainCommunicationError::from_other_str(
                "TX hash exceeds 64 bytes",
            ));
        }

        let mut padded = [0u8; 64];
        let start = 64usize.saturating_sub(hash_bytes.len());
        padded[start..].copy_from_slice(&hash_bytes);
        Ok(H512::from_slice(&padded))
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        _tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Ok(vec![])
    }
}

/// Interface for indexing data in sequence.
/// SequenceAwareIndexer is an umbrella trait for all indexers types (sequence-aware and rate-limited).
/// The rate-limited indexer doesn't need `SequenceAwareIndexer`, so impls of `SequenceAwareIndexer` just return nullish values.
/// TODO: Refactor such that indexers aren't required to implement `SequenceAwareIndexer`
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait SequenceAwareIndexer<T>: Indexer<T> {
    /// Return the latest finalized sequence (if any) and block number
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)>;
}

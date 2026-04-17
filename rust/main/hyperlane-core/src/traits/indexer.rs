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

    /// Parse an EVM hex-encoded transaction hash string to H512.
    fn parse_tx_hash(&self, tx_hash: &str) -> ChainResult<H512> {
        use crate::ChainCommunicationError;

        // Strip at most one "0x" prefix
        let tx_hash_clean = tx_hash.strip_prefix("0x").unwrap_or(tx_hash);

        // Reject empty input
        if tx_hash_clean.is_empty() {
            return Err(ChainCommunicationError::from_other_str(
                "TX hash cannot be empty",
            ));
        }

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

    /// Check whether a transaction originates from a CCTP V2 fast transfer.
    /// Returns false by default; only EVM chains override this.
    async fn is_cctp_v2(&self, _tx_hash: H512) -> ChainResult<bool> {
        Ok(false)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HyperlaneMessage;

    // Mock indexer for testing default parse_tx_hash implementation
    #[derive(Debug)]
    struct MockIndexer;

    #[async_trait]
    impl Indexer<HyperlaneMessage> for MockIndexer {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
            Ok(vec![])
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Ok(0)
        }
    }

    #[test]
    fn test_parse_tx_hash_hex_no_prefix() {
        let indexer = MockIndexer;
        // 64-byte hash (128 hex chars)
        let tx_hash = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        let result = indexer.parse_tx_hash(tx_hash);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(
            parsed,
            H512::from_slice(
                &hex::decode("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef")
                    .unwrap()
            )
        );
    }

    #[test]
    fn test_parse_tx_hash_hex_with_prefix() {
        let indexer = MockIndexer;
        // 64-byte hash (128 hex chars) with 0x prefix
        let tx_hash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        let result = indexer.parse_tx_hash(tx_hash);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(
            parsed,
            H512::from_slice(
                &hex::decode("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef")
                    .unwrap()
            )
        );
    }

    #[test]
    fn test_parse_tx_hash_short_hash() {
        let indexer = MockIndexer;
        let tx_hash = "0x1234";
        let result = indexer.parse_tx_hash(tx_hash);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        // Should be left-padded with zeros
        let mut expected = [0u8; 64];
        expected[62] = 0x12;
        expected[63] = 0x34;
        assert_eq!(parsed, H512::from_slice(&expected));
    }

    #[test]
    fn test_parse_tx_hash_invalid_hex() {
        let indexer = MockIndexer;
        let tx_hash = "0xGHIJKL"; // Invalid hex characters
        let result = indexer.parse_tx_hash(tx_hash);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Invalid hex"));
    }

    #[test]
    fn test_parse_tx_hash_too_long() {
        let indexer = MockIndexer;
        // 65 bytes (130 hex chars) - exceeds H512 size
        let tx_hash = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12";
        let result = indexer.parse_tx_hash(tx_hash);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("exceeds 64 bytes"));
    }

    #[test]
    fn test_parse_tx_hash_empty() {
        let indexer = MockIndexer;
        let tx_hash = "";
        let result = indexer.parse_tx_hash(tx_hash);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cannot be empty"));
    }

    #[test]
    fn test_parse_tx_hash_only_prefix() {
        let indexer = MockIndexer;
        let tx_hash = "0x";
        let result = indexer.parse_tx_hash(tx_hash);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cannot be empty"));
    }
}

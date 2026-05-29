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

    /// Parse a chain-specific transaction hash string into an [`H512`].
    ///
    /// The default implementation returns an error — chains must override this
    /// with their own encoding (EVM: [`parse_evm_hex_tx_hash`], Sealevel: base58,
    /// Aleo/Radix: bech32m, etc.). A default that silently decodes hex would give
    /// non-EVM callers a misleading "invalid hex" error instead of a clear
    /// "not supported" response.
    fn parse_tx_hash(&self, _tx_hash: &str) -> ChainResult<H512> {
        Err(crate::ChainCommunicationError::from_other_str(
            "tx-hash-based lookup is not supported for this chain",
        ))
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        _tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Ok(vec![])
    }

    /// Fetch logs and check CCTP V2 status from a single transaction.
    ///
    /// Non-EVM chains use the default, which returns `false` for the CCTP flag
    /// (CCTP is EVM-only). EVM chains override this to extract both from a single
    /// `get_transaction_receipt` RPC call.
    async fn fetch_logs_and_cctp_v2(
        &self,
        tx_hash: H512,
    ) -> ChainResult<(Vec<(Indexed<T>, LogMeta)>, bool)> {
        let logs = self.fetch_logs_by_tx_hash(tx_hash).await?;
        Ok((logs, false))
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

/// Parse an EVM hex-encoded transaction hash string into an [`H512`].
///
/// Accepts an optional `0x` prefix. Hashes shorter than 64 bytes are
/// right-aligned (zero-padded on the left) to match [`H512`]'s layout —
/// `From<H512> for H256` reads `bytes[32..64]`, so a 32-byte EVM hash
/// placed at the right half round-trips correctly.
///
/// EVM [`Indexer`] implementations should call this from their
/// `parse_tx_hash` override rather than re-implementing the logic.
pub fn parse_evm_hex_tx_hash(tx_hash: &str) -> ChainResult<H512> {
    use crate::ChainCommunicationError;

    let tx_hash_clean = tx_hash.strip_prefix("0x").unwrap_or(tx_hash);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HyperlaneMessage;

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
    fn test_parse_tx_hash_default_not_supported() {
        let err = MockIndexer.parse_tx_hash("0xdeadbeef").unwrap_err();
        assert!(err.to_string().contains("not supported"));
    }

    #[test]
    fn test_parse_evm_hex_no_prefix() {
        let tx_hash = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        let parsed = parse_evm_hex_tx_hash(tx_hash).unwrap();
        assert_eq!(parsed, H512::from_slice(&hex::decode(tx_hash).unwrap()));
    }

    #[test]
    fn test_parse_evm_hex_with_prefix() {
        let inner = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        let parsed = parse_evm_hex_tx_hash(&format!("0x{inner}")).unwrap();
        assert_eq!(parsed, H512::from_slice(&hex::decode(inner).unwrap()));
    }

    #[test]
    fn test_parse_evm_hex_short_right_aligned() {
        let parsed = parse_evm_hex_tx_hash("0x1234").unwrap();
        let mut expected = [0u8; 64];
        expected[62] = 0x12;
        expected[63] = 0x34;
        assert_eq!(parsed, H512::from_slice(&expected));
    }

    #[test]
    fn test_parse_evm_hex_invalid() {
        assert!(parse_evm_hex_tx_hash("0xGHIJKL")
            .unwrap_err()
            .to_string()
            .contains("Invalid hex"));
    }

    #[test]
    fn test_parse_evm_hex_too_long() {
        let tx_hash = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12";
        assert!(parse_evm_hex_tx_hash(tx_hash)
            .unwrap_err()
            .to_string()
            .contains("exceeds 64 bytes"));
    }

    #[test]
    fn test_parse_evm_hex_empty() {
        assert!(parse_evm_hex_tx_hash("")
            .unwrap_err()
            .to_string()
            .contains("cannot be empty"));
    }

    #[test]
    fn test_parse_evm_hex_only_prefix() {
        assert!(parse_evm_hex_tx_hash("0x")
            .unwrap_err()
            .to_string()
            .contains("cannot be empty"));
    }
}

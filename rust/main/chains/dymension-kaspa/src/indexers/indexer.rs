use hyperlane_core::{ChainResult, H256};

use auto_impl::auto_impl;

use hyperlane_core::{
    ChainCommunicationError, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion,
    SequenceAwareIndexer,
};
#[auto_impl(&, Box, Arc)]
#[derive(Debug, Clone)]
pub struct KaspaIndexer {}
pub struct DispatchIndexer {}
pub struct DeliveryIndexer {}
pub struct IGPIndexer {}
pub struct MerkleTreeIndexer {}

// dispatches
impl SequenceAwareIndexer<HyperlaneMessage> for DispatchIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        Ok(vec![])
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(0)
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        _tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Ok(vec![])
    }
}

// deliveries
impl SequenceAwareIndexer<H256> for DeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

// IGP
// dispatches
impl SequenceAwareIndexer<InterchainGasPayment> for IGPIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

// merkle tree insertion
impl SequenceAwareIndexer<MerkleTreeInsertion> for MerkleTreeIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

use hyperlane_core::{ChainResult, H256};

use hyperlane_core::{
    ChainCommunicationError, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion,
    SequenceAwareIndexer,
};

pub struct KaspaIndexer {}
pub struct DeliveryIndexer{}
pub struct DispatchIndexer{}
pub struct IGPIndexer{}
pub struct MerkleTreeIndexer{}

// deliveries
impl SequenceAwareIndexer<H256> for DeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

// dispatches
impl SequenceAwareIndexer<HyperlaneMessage> for DispatchIndexer {
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

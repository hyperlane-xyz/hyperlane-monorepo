pub(crate) mod sequence_aware;

use hyperlane_core::{
    Delivery, HyperlaneDomainProtocol, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion,
};
pub(crate) use sequence_aware::ForwardBackwardSequenceAwareSyncCursor;

pub(crate) mod rate_limited;
pub(crate) use rate_limited::RateLimitedContractSyncCursor;

pub enum CursorType {
    SequenceAware,
    RateLimited,
}

// H256 * 1M = 32MB per origin chain worst case
// With one such channel per origin chain.
const TX_ID_CHANNEL_CAPACITY: Option<usize> = Some(1_000_000);

pub trait Indexable {
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType;
    fn broadcast_channel_size() -> Option<usize> {
        None
    }
}

impl Indexable for HyperlaneMessage {
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType {
        match domain {
            HyperlaneDomainProtocol::Ethereum => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Fuel => todo!(),
            HyperlaneDomainProtocol::Sealevel => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Cosmos => CursorType::SequenceAware,
        }
    }

    // Only broadcast txids from the message indexing task
    fn broadcast_channel_size() -> Option<usize> {
        TX_ID_CHANNEL_CAPACITY
    }
}

impl Indexable for InterchainGasPayment {
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType {
        match domain {
            HyperlaneDomainProtocol::Ethereum => CursorType::RateLimited,
            HyperlaneDomainProtocol::Fuel => todo!(),
            HyperlaneDomainProtocol::Sealevel => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Cosmos => CursorType::RateLimited,
        }
    }
}

impl Indexable for MerkleTreeInsertion {
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType {
        match domain {
            HyperlaneDomainProtocol::Ethereum => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Fuel => todo!(),
            HyperlaneDomainProtocol::Sealevel => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Cosmos => CursorType::SequenceAware,
        }
    }
}

impl Indexable for Delivery {
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType {
        match domain {
            HyperlaneDomainProtocol::Ethereum => CursorType::RateLimited,
            HyperlaneDomainProtocol::Fuel => todo!(),
            HyperlaneDomainProtocol::Sealevel => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Cosmos => CursorType::RateLimited,
        }
    }
}

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

// H512 * 30k =~ 2MB per origin chain
const TX_ID_CHANNEL_CAPACITY: Option<usize> = Some(30_000);

pub trait Indexable {
    /// Returns the configured cursor type of this type for the given domain, (e.g. `SequenceAware` or `RateLimited`)
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType;
    /// Indexing tasks may have channels open between them to share information that improves reliability (such as the txid where a message event was indexed).
    /// By default this method is None, and it should return a channel capacity if this indexing task is to broadcast anything to other tasks.
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
            HyperlaneDomainProtocol::Starknet => CursorType::SequenceAware,
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
            HyperlaneDomainProtocol::Starknet => CursorType::RateLimited,
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
            HyperlaneDomainProtocol::Starknet => CursorType::SequenceAware,
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
            HyperlaneDomainProtocol::Starknet => CursorType::RateLimited,
        }
    }
}

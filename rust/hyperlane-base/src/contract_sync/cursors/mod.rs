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

pub trait Indexable {
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType;
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

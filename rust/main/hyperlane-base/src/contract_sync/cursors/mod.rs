use hyperlane_core::{
    Delivery, HyperlaneDomainProtocol, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion,
};

pub(crate) mod sequence_aware;
pub(crate) use sequence_aware::ForwardBackwardSequenceAwareSyncCursor;

pub(crate) mod rate_limited;
pub(crate) use rate_limited::RateLimitedContractSyncCursor;

pub(crate) mod metrics;
pub(crate) use metrics::CursorMetrics;

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
    /// Returns the name of the type for metrics.
    fn name() -> &'static str;
}

impl Indexable for HyperlaneMessage {
    fn indexing_cursor(domain: HyperlaneDomainProtocol) -> CursorType {
        match domain {
            HyperlaneDomainProtocol::Ethereum => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Fuel => todo!(),
            HyperlaneDomainProtocol::Sealevel => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Cosmos => CursorType::SequenceAware,
            HyperlaneDomainProtocol::Starknet => CursorType::SequenceAware,
            HyperlaneDomainProtocol::CosmosNative => CursorType::SequenceAware,
        }
    }

    // Only broadcast txids from the message indexing task
    fn broadcast_channel_size() -> Option<usize> {
        TX_ID_CHANNEL_CAPACITY
    }

    fn name() -> &'static str {
        "hyperlane_message"
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
            HyperlaneDomainProtocol::CosmosNative => CursorType::RateLimited,
        }
    }

    fn name() -> &'static str {
        "interchain_gas_payment"
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
            HyperlaneDomainProtocol::CosmosNative => CursorType::SequenceAware,
        }
    }

    fn name() -> &'static str {
        "merkle_tree_insertion"
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
            HyperlaneDomainProtocol::CosmosNative => CursorType::RateLimited,
        }
    }

    fn name() -> &'static str {
        "delivery"
    }
}

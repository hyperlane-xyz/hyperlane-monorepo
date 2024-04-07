pub(crate) mod sequence_aware;

use hyperlane_core::HyperlaneDomainProtocol;
pub(crate) use sequence_aware::ForwardBackwardSequenceAwareSyncCursor;

pub(crate) mod rate_limited;
pub(crate) use rate_limited::RateLimitedContractSyncCursor;

pub enum CursorType {
    SequenceAware,
    RateLimited,
}

impl From<HyperlaneDomainProtocol> for CursorType {
    fn from(value: HyperlaneDomainProtocol) -> Self {
        match value {
            HyperlaneDomainProtocol::Ethereum => Self::RateLimited,
            HyperlaneDomainProtocol::Fuel => todo!(),
            HyperlaneDomainProtocol::Sealevel => Self::RateLimited,
            HyperlaneDomainProtocol::Cosmos => Self::RateLimited,
        }
    }
}

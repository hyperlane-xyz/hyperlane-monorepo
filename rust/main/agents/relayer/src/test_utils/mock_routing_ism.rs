use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, RoutingIsm,
    H256,
};

type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

#[derive(Debug, Default)]
pub struct MockRoutingIsmResponses {
    pub route: ResponseList<ChainResult<H256>>,
}

#[derive(Debug)]
pub struct MockRoutingIsm {
    pub address: H256,
    pub domain: HyperlaneDomain,
    pub responses: MockRoutingIsmResponses,
}

impl MockRoutingIsm {
    pub fn new(address: H256, domain: HyperlaneDomain) -> Self {
        Self {
            address,
            domain,
            responses: MockRoutingIsmResponses::default(),
        }
    }
}

#[async_trait::async_trait]
impl RoutingIsm for MockRoutingIsm {
    async fn route(&self, _message: &HyperlaneMessage) -> ChainResult<H256> {
        self.responses
            .route
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock route response set")
    }
}

impl HyperlaneContract for MockRoutingIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for MockRoutingIsm {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        unimplemented!()
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::KnownHyperlaneDomain;

    use super::*;

    /// Just to test mock structs work
    #[tokio::test]
    async fn test_mock_works() {
        let mock_ism = MockRoutingIsm::new(
            H256::zero(),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        );
        mock_ism
            .responses
            .route
            .lock()
            .unwrap()
            .push_back(Ok(H256::zero()));
        mock_ism
            .responses
            .route
            .lock()
            .unwrap()
            .push_back(Ok(H256::from_low_u64_le(10)));

        let message = HyperlaneMessage::default();
        let module_type = mock_ism.route(&message).await.expect("No response");
        assert_eq!(module_type, H256::zero());

        let module_type = mock_ism.route(&message).await.expect("No response");
        assert_eq!(module_type, H256::from_low_u64_le(10));
    }
}

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
    pub domain: Option<HyperlaneDomain>,
}

#[derive(Debug, Default)]
pub struct MockRoutingIsm {
    pub responses: MockRoutingIsmResponses,
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
        H256::zero()
    }
}

impl HyperlaneChain for MockRoutingIsm {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        self.responses
            .domain
            .as_ref()
            .expect("No mock domain response set")
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        unimplemented!()
    }
}

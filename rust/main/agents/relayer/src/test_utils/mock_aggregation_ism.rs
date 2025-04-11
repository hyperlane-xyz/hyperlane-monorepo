use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use hyperlane_core::{
    AggregationIsm, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, H256,
};

type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

#[derive(Debug, Default)]
pub struct MockAggregationIsmResponses {
    pub modules_and_threshold: ResponseList<ChainResult<(Vec<H256>, u8)>>,
}

#[derive(Debug)]
pub struct MockAggregationIsm {
    pub address: H256,
    pub domain: HyperlaneDomain,
    pub responses: MockAggregationIsmResponses,
}

impl MockAggregationIsm {
    pub fn new(address: H256, domain: HyperlaneDomain) -> Self {
        Self {
            address,
            domain,
            responses: MockAggregationIsmResponses::default(),
        }
    }
}

#[async_trait::async_trait]
impl AggregationIsm for MockAggregationIsm {
    async fn modules_and_threshold(
        &self,
        _message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        self.responses
            .modules_and_threshold
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock modules_and_threshold response set")
    }
}

impl HyperlaneContract for MockAggregationIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for MockAggregationIsm {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        unimplemented!()
    }
}

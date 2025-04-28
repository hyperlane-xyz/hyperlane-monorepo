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
    pub domain: Option<HyperlaneDomain>,
}

#[derive(Debug, Default)]
pub struct MockAggregationIsm {
    pub responses: MockAggregationIsmResponses,
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
        H256::zero()
    }
}

impl HyperlaneChain for MockAggregationIsm {
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

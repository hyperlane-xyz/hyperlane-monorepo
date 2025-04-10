use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use hyperlane_base::{
    cache::{LocalCache, MeteredCache},
    settings::CheckpointSyncerBuildError,
    MultisigCheckpointSyncer,
};
use hyperlane_core::{
    accumulator::merkle::Proof, AggregationIsm, CcipReadIsm, Checkpoint, HyperlaneDomain,
    HyperlaneMessage, InterchainSecurityModule, MultisigIsm, RoutingIsm, H256,
};

use crate::msg::metadata::{BuildsBaseMetadata, IsmAwareAppContextClassifier};

type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

#[derive(Debug, Default)]
pub struct MockBaseMetadataBuilderResponses {
    pub origin_domain: Option<HyperlaneDomain>,
    pub destination_domain: Option<HyperlaneDomain>,
    pub app_context_classifier: Option<IsmAwareAppContextClassifier>,
    pub cache: Option<MeteredCache<LocalCache>>,
    pub get_proof: ResponseList<eyre::Result<Proof>>,
    pub highest_known_leaf_index: ResponseList<Option<u32>>,
    pub get_merkle_leaf_id_by_message_id: ResponseList<eyre::Result<Option<u32>>>,
    /// build_ism uses a hashmap of VecDeque responses instead.
    /// This is because AggregationISMs run in parallel, so having just
    /// a single VecDeque shared between the different threads yields unpredictable
    /// results. One thread might run for a long time and overwriting each others
    /// responses.
    /// In order to fix this in tests, the mock ISMs are built with specific addresses
    /// in place. And gets responses from this based on the address.
    #[allow(clippy::type_complexity)]
    pub build_ism:
        Arc<Mutex<HashMap<H256, VecDeque<eyre::Result<Box<dyn InterchainSecurityModule>>>>>>,
    pub build_routing_ism: Arc<Mutex<HashMap<H256, VecDeque<eyre::Result<Box<dyn RoutingIsm>>>>>>,
    pub build_aggregation_ism:
        Arc<Mutex<HashMap<H256, VecDeque<eyre::Result<Box<dyn AggregationIsm>>>>>>,
    // TODO: migrate these to be keyed by address as well
    pub build_multisig_ism: ResponseList<eyre::Result<Box<dyn MultisigIsm>>>,
    pub build_ccip_read_ism: ResponseList<eyre::Result<Box<dyn CcipReadIsm>>>,
    pub build_checkpoint_syncer:
        ResponseList<Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError>>,
}

impl MockBaseMetadataBuilderResponses {
    pub fn push_build_ism_response(
        &self,
        address: H256,
        ism: eyre::Result<Box<dyn InterchainSecurityModule>>,
    ) {
        self.build_ism
            .lock()
            .unwrap()
            .entry(address)
            .or_default()
            .push_back(ism);
    }

    pub fn push_build_aggregation_ism_response(
        &self,
        address: H256,
        ism: eyre::Result<Box<dyn AggregationIsm>>,
    ) {
        self.build_aggregation_ism
            .lock()
            .unwrap()
            .entry(address)
            .or_default()
            .push_back(ism);
    }

    pub fn push_build_routing_ism_response(
        &self,
        address: H256,
        ism: eyre::Result<Box<dyn RoutingIsm>>,
    ) {
        self.build_routing_ism
            .lock()
            .unwrap()
            .entry(address)
            .or_default()
            .push_back(ism);
    }
}

#[derive(Debug, Default)]
pub struct MockBaseMetadataBuilder {
    pub responses: MockBaseMetadataBuilderResponses,
}

impl MockBaseMetadataBuilder {
    pub fn new() -> Self {
        Self {
            responses: MockBaseMetadataBuilderResponses::default(),
        }
    }
}

#[async_trait::async_trait]
impl BuildsBaseMetadata for MockBaseMetadataBuilder {
    fn origin_domain(&self) -> &HyperlaneDomain {
        self.responses
            .origin_domain
            .as_ref()
            .expect("No mock origin_domain response set")
    }
    fn destination_domain(&self) -> &HyperlaneDomain {
        self.responses
            .destination_domain
            .as_ref()
            .expect("No mock destination_domain response set")
    }
    fn app_context_classifier(&self) -> &IsmAwareAppContextClassifier {
        self.responses
            .app_context_classifier
            .as_ref()
            .expect("No mock app_context_classifier response set")
    }
    fn cache(&self) -> &MeteredCache<LocalCache> {
        self.responses
            .cache
            .as_ref()
            .expect("No mock cache response set")
    }

    async fn get_proof(&self, _leaf_index: u32, _checkpoint: Checkpoint) -> eyre::Result<Proof> {
        self.responses
            .get_proof
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock get_proof response set")
    }
    async fn highest_known_leaf_index(&self) -> Option<u32> {
        self.responses
            .highest_known_leaf_index
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock highest_known_leaf_index response set")
    }
    async fn get_merkle_leaf_id_by_message_id(
        &self,
        _message_id: H256,
    ) -> eyre::Result<Option<u32>> {
        self.responses
            .get_merkle_leaf_id_by_message_id
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock get_merkle_leaf_id_by_message_id response set")
    }
    async fn build_ism(&self, address: H256) -> eyre::Result<Box<dyn InterchainSecurityModule>> {
        self.responses
            .build_ism
            .lock()
            .unwrap()
            .get_mut(&address)
            .expect("No mock build_ism response set")
            .pop_front()
            .expect("No mock build_ism response set")
    }
    async fn build_routing_ism(&self, address: H256) -> eyre::Result<Box<dyn RoutingIsm>> {
        self.responses
            .build_routing_ism
            .lock()
            .unwrap()
            .get_mut(&address)
            .expect("No mock build_aggregation_ism response set")
            .pop_front()
            .expect("No mock build_aggregation_ism response set")
    }
    async fn build_multisig_ism(&self, _address: H256) -> eyre::Result<Box<dyn MultisigIsm>> {
        self.responses
            .build_multisig_ism
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock build_multisig_ism response set")
    }
    async fn build_aggregation_ism(&self, address: H256) -> eyre::Result<Box<dyn AggregationIsm>> {
        self.responses
            .build_aggregation_ism
            .lock()
            .unwrap()
            .get_mut(&address)
            .expect("No mock build_aggregation_ism response set")
            .pop_front()
            .expect("No mock build_aggregation_ism response set")
    }
    async fn build_ccip_read_ism(&self, _address: H256) -> eyre::Result<Box<dyn CcipReadIsm>> {
        self.responses
            .build_ccip_read_ism
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock build_ccip_read_ism response set")
    }
    async fn build_checkpoint_syncer(
        &self,
        _message: &HyperlaneMessage,
        _validators: &[H256],
        _app_context: Option<String>,
    ) -> Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError> {
        self.responses
            .build_checkpoint_syncer
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock build_checkpoint_syncer response set")
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::ModuleType;

    use crate::test_utils::mock_ism::MockInterchainSecurityModule;

    use super::*;

    /// Just to test mock structs work
    #[tokio::test]
    async fn test_mock_works() {
        let base_builder = MockBaseMetadataBuilder::default();
        let domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);
        {
            let mock_ism = MockInterchainSecurityModule::new(
                H256::zero(),
                domain.clone(),
                ModuleType::Routing,
            );
            base_builder
                .responses
                .push_build_ism_response(H256::zero(), Ok(Box::new(mock_ism)));
        }
        {
            let mock_ism = MockInterchainSecurityModule::new(
                H256::zero(),
                domain.clone(),
                ModuleType::Aggregation,
            );
            base_builder
                .responses
                .push_build_ism_response(H256::from_low_u64_be(10), Ok(Box::new(mock_ism)));
        }

        let ism = base_builder
            .build_ism(H256::zero())
            .await
            .expect("No response");
        let module_type = ism.module_type().await.expect("No response");

        assert_eq!(module_type, ModuleType::Routing);

        let ism = base_builder
            .build_ism(H256::from_low_u64_be(10))
            .await
            .expect("No response");
        let module_type = ism.module_type().await.expect("No response");

        assert_eq!(module_type, ModuleType::Aggregation);
    }
}

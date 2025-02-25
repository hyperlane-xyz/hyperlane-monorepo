use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use hyperlane_base::{settings::CheckpointSyncerBuildError, MultisigCheckpointSyncer};
use hyperlane_core::{
    accumulator::merkle::Proof, AggregationIsm, CcipReadIsm, Checkpoint, HyperlaneDomain,
    HyperlaneMessage, InterchainSecurityModule, MultisigIsm, RoutingIsm, H256,
};

use crate::msg::metadata::{BaseMetadataBuilderTrait, IsmAwareAppContextClassifier};

type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

#[derive(Debug, Default)]
pub struct MockBaseMetadataBuilderResponses {
    pub origin_domain: Option<HyperlaneDomain>,
    pub destination_domain: Option<HyperlaneDomain>,
    pub app_context_classifier: Option<IsmAwareAppContextClassifier>,
    pub get_proof: ResponseList<eyre::Result<Proof>>,
    pub highest_known_leaf_index: ResponseList<Option<u32>>,
    pub get_merkle_leaf_id_by_message_id: ResponseList<eyre::Result<Option<u32>>>,
    pub build_ism: ResponseList<eyre::Result<Box<dyn InterchainSecurityModule>>>,
    pub build_routing_ism: ResponseList<eyre::Result<Box<dyn RoutingIsm>>>,
    pub build_multisig_ism: ResponseList<eyre::Result<Box<dyn MultisigIsm>>>,
    pub build_aggregation_ism: ResponseList<eyre::Result<Box<dyn AggregationIsm>>>,
    pub build_ccip_read_ism: ResponseList<eyre::Result<Box<dyn CcipReadIsm>>>,
    pub build_checkpoint_syncer:
        ResponseList<Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError>>,
}

#[derive(Debug)]
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
impl BaseMetadataBuilderTrait for MockBaseMetadataBuilder {
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
    async fn build_ism(&self, _address: H256) -> eyre::Result<Box<dyn InterchainSecurityModule>> {
        self.responses
            .build_ism
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock build_ism response set")
    }
    async fn build_routing_ism(&self, _address: H256) -> eyre::Result<Box<dyn RoutingIsm>> {
        self.responses
            .build_routing_ism
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock build_routing_ism response set")
    }
    async fn build_multisig_ism(&self, _address: H256) -> eyre::Result<Box<dyn MultisigIsm>> {
        self.responses
            .build_multisig_ism
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock build_multisig_ism response set")
    }
    async fn build_aggregation_ism(&self, _address: H256) -> eyre::Result<Box<dyn AggregationIsm>> {
        self.responses
            .build_aggregation_ism
            .lock()
            .unwrap()
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

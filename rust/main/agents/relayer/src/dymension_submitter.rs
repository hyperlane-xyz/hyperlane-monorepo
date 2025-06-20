use crate::msg::{
    metadata::multisig::{
        MessageIdMultisigMetadataBuilder, MultisigIsmMetadataBuilder, MultisigMetadata,
    },
    metadata::BuildsBaseMetadata,
    metadata::MessageMetadataBuilder,
    metadata::Metadata,
    pending_message::MessageContext,
    pending_message::PendingMessage,
};

use hyperlane_core::{
    traits::PendingOperationResult, AggregationIsm, CcipReadIsm, Checkpoint, HyperlaneDomain,
    HyperlaneMessage, InterchainSecurityModule, MultisigIsm, MultisigSignedCheckpoint, RoutingIsm,
    H256,
};
use mockall::mock;
use std::sync::Arc;

use eyre::Result;

pub struct PendingMessageMetadataGetter {
    builder: MessageIdMultisigMetadataBuilder,
}

impl PendingMessageMetadataGetter {
    pub fn new(builder: MessageIdMultisigMetadataBuilder) -> Self {
        Self { builder }
    }
    pub fn new_alt() -> Self {
        Self {
            builder: MessageIdMultisigMetadataBuilder::new(MessageMetadataBuilder {
                base: Arc::new(DummyBuildsBaseMetadata),
                app_context: None,
                root_ism: H256::random(),
                max_ism_depth: 0,
                max_ism_count: 0,
            }),
        }
    }
}

impl PendingMessageMetadataGetter {
    pub fn metadata(&self, checkpoint: MultisigSignedCheckpoint) -> Result<Vec<u8>> {
        // now mimic https://github.com/dymensionxyz/hyperlane-monorepo/blob/f4836a2a7291864d0c1850dbbcecd6af54addce3/rust/main/agents/relayer/src/msg/metadata/multisig/base.rs#L226-L235
        let meta: MultisigMetadata = MultisigMetadata::new(checkpoint, 0, None);

        let formatter = self.builder.as_ref() as &dyn MultisigIsmMetadataBuilder;
        formatter.format_metadata(meta)
    }
}

struct DummyBuildsBaseMetadata;

impl BuildsBaseMetadata for DummyBuildsBaseMetadata {
    fn origin_domain(&self) -> &HyperlaneDomain {
        todo!();
    }
    fn destination_domain(&self) -> &HyperlaneDomain {
        todo!();
    }
    fn app_context_classifier(&self) -> &IsmAwareAppContextClassifier {
        todo!();
    }
    fn ism_cache_policy_classifier(&self) -> &IsmCachePolicyClassifier {
        todo!();
    }
    fn cache(&self) -> &OptionalCache<MeteredCache<LocalCache>> {
        todo!();
    }
    fn get_signer(&self) -> Option<&Signers> {
        todo!();
    }

    async fn get_proof(&self, _leaf_index: u32, _checkpoint: Checkpoint) -> eyre::Result<Proof> {
        todo!();
    }
    async fn highest_known_leaf_index(&self) -> Option<u32> {
        todo!();
    }
    async fn get_merkle_leaf_id_by_message_id(
        &self,
        _message_id: H256,
    ) -> eyre::Result<Option<u32>> {
        todo!();
    }
    async fn build_ism(&self, _address: H256) -> eyre::Result<Box<dyn InterchainSecurityModule>> {
        todo!();
    }
    async fn build_routing_ism(&self, _address: H256) -> eyre::Result<Box<dyn RoutingIsm>> {
        todo!();
    }
    async fn build_multisig_ism(&self, _address: H256) -> eyre::Result<Box<dyn MultisigIsm>> {
        todo!();
    }
    async fn build_aggregation_ism(&self, _address: H256) -> eyre::Result<Box<dyn AggregationIsm>> {
        todo!();
    }
    async fn build_ccip_read_ism(&self, _address: H256) -> eyre::Result<Box<dyn CcipReadIsm>> {
        todo!();
    }
    async fn build_checkpoint_syncer(
        &self,
        _message: &HyperlaneMessage,
        _validators: &[H256],
        _app_context: Option<String>,
    ) -> Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError> {
        todo!();
    }
}

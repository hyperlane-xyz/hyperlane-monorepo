use crate::msg::{
    metadata::multisig::{
        MessageIdMultisigMetadataBuilder, MultisigIsmMetadataBuilder, MultisigMetadata,
    },
    metadata::BuildsBaseMetadata,
    metadata::Metadata,
    pending_message::MessageContext,
    pending_message::PendingMessage,
};

use hyperlane_core::{traits::PendingOperationResult, HyperlaneMessage, MultisigSignedCheckpoint};
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
        Self { builder: MessageIdMultisigMetadataBuilder::new(
            MessageMetadataBuilder{
                base: Arc::new(DummyBuildsBaseMetadata),
                app_context: None,
                root_ism: H256::random(),
                max_ism_depth: 0,
                max_ism_count: 0,
            }
        ) }
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

// impl BuildsBaseMetadata for DummyBuildsBaseMetadata {}

// Paste the trait definition here, inside the mock! macro.
// mockall will generate `MockBuildsBaseMetadata` that implements the trait.
mock! {
    pub BuildsBaseMetadata {}

    // The macro handles async traits automatically
    #[async_trait::async_trait]
    impl BuildsBaseMetadata for BuildsBaseMetadata {
        fn origin_domain(&self) -> &HyperlaneDomain;
        fn destination_domain(&self) -> &HyperlaneDomain;
        fn app_context_classifier(&self) -> &IsmAwareAppContextClassifier;
        fn ism_cache_policy_classifier(&self) -> &IsmCachePolicyClassifier;
        fn cache(&self) -> &OptionalCache<MeteredCache<LocalCache>>;
        fn get_signer(&self) -> Option<&Signers>;

        async fn get_proof(&self, leaf_index: u32, checkpoint: Checkpoint) -> eyre::Result<Proof>;
        async fn highest_known_leaf_index(&self) -> Option<u32>;
        async fn get_merkle_leaf_id_by_message_id(&self, message_id: H256) -> eyre::Result<Option<u32>>;
        async fn build_ism(&self, address: H256) -> eyre::Result<Box<dyn InterchainSecurityModule>>;
        async fn build_routing_ism(&self, address: H256) -> eyre::Result<Box<dyn RoutingIsm>>;
        async fn build_multisig_ism(&self, address: H256) -> eyre::Result<Box<dyn MultisigIsm>>;
        async fn build_aggregation_ism(&self, address: H256) -> eyre::Result<Box<dyn AggregationIsm>>;
        async fn build_ccip_read_ism(&self, address: H256) -> eyre::Result<Box<dyn CcipReadIsm>>;
        async fn build_checkpoint_syncer(
            &self,
            message: &HyperlaneMessage,
            validators: &[H256],
            app_context: Option<String>,
        ) -> Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError>;
    }
}

// Now, you can create the builder with the mock object.
fn create_builder_with_dummy() -> MessageMetadataBuilder {
    // This mock will panic if any of its methods are actually called,
    // which is the safe behavior you want.
    let mock_base = MockBuildsBaseMetadata::new();

    MessageMetadataBuilder {
        base: Arc::new(mock_base),
    }
}

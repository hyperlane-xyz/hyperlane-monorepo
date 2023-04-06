use async_trait::async_trait;
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use std::fmt::Debug;
use std::sync::Arc;

use derive_new::new;
use eyre::Context;
use tokio::sync::RwLock;
use tracing::{instrument};

use hyperlane_base::{
    ChainSetup, CoreMetrics
};
use hyperlane_core::{HyperlaneMessage, ValidatorAnnounce, H256};

use crate::{merkle_tree_builder::MerkleTreeBuilder, msg::metadata::LegacyMultisigIsmMetadataBuilder};

#[derive(Debug, thiserror::Error)]
pub enum MetadataBuilderError {
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(u8),
}

#[derive(FromPrimitive)]
pub enum SupportedIsmTypes {
    // Routing = 1,
    // Aggregation = 2,
    LegacyMultisig = 3,
    // Multisig = 4,
}

#[async_trait]
pub trait MetadataBuilder {
    #[allow(clippy::async_yields_async)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>>;
}

#[derive(Clone, new)]
pub struct BaseMetadataBuilder {
    pub chain_setup: ChainSetup,
    pub prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    pub validator_announce: Arc<dyn ValidatorAnnounce>,
    pub allow_local_checkpoint_syncers: bool,
    pub metrics: Arc<CoreMetrics>,
}

impl Debug for BaseMetadataBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MetadataBuilder {{ chain_setup: {:?}, validator_announce: {:?} }}",
            self.chain_setup, self.validator_announce
        )
    }
}

#[async_trait]
impl MetadataBuilder for BaseMetadataBuilder {
    #[instrument(err)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching module type";
        let ism = self
            .chain_setup
            .build_ism(ism_address, &self.metrics)
            .await
            .context(CTX)?;
        let module_type = ism.module_type().await.context(CTX)?;
        let supported_type = SupportedIsmTypes::from_u8(module_type)
            .ok_or(MetadataBuilderError::UnsupportedModuleType(module_type))
            .context(CTX)?;

        let metadata_builder = match supported_type {
            SupportedIsmTypes::LegacyMultisig => {
                LegacyMultisigIsmMetadataBuilder::new(self.clone())
            }
        };
        metadata_builder
            .build(ism_address, message)
            .await
            .context(CTX)
    }
}

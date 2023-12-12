use std::{
    collections::{HashMap, HashSet},
    fmt::Debug,
    future::Future,
    pin::Pin,
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::{
    merkle_tree::builder::MerkleTreeBuilder,
    msg::metadata::{
        multisig::{MerkleRootMultisigMetadataBuilder, MessageIdMultisigMetadataBuilder},
        AggregationIsmMetadataBuilder, CcipReadIsmMetadataBuilder, NullMetadataBuilder,
        RoutingIsmMetadataBuilder,
    },
    settings::matching_list::MatchingList,
};
use async_trait::async_trait;
use derive_new::new;
use eyre::{Context, Result};
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::{
    settings::{ChainConf, CheckpointSyncerConf},
    CheckpointSyncer, CoreMetrics, MultisigCheckpointSyncer,
};
use hyperlane_core::{
    accumulator::merkle::Proof, AggregationIsm, CcipReadIsm, ChainResult, Checkpoint,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, Mailbox, ModuleType, MultisigIsm,
    RoutingIsm, ValidatorAnnounce, H160, H256,
};
use prometheus::{
    core::{AtomicI64, GenericGauge},
    IntGauge, IntGaugeVec,
};
use serde::de;
use tokio::sync::RwLock;
use tracing::{debug, info, instrument, warn};

#[derive(Debug, thiserror::Error)]
pub enum MetadataBuilderError {
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(ModuleType),
    #[error("Exceeded max depth when building metadata ({0})")]
    MaxDepthExceeded(u32),
}

pub struct IsmWithMetadataAndType {
    pub ism: Box<dyn InterchainSecurityModule>,
    pub metadata: Option<Vec<u8>>,
    pub module_type: ModuleType,
}

#[async_trait]
pub trait MetadataBuilder: Send + Sync {
    // TODO rm?
    #[allow(clippy::async_yields_async)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        metric_app_context: Option<String>,
    ) -> Result<Option<Vec<u8>>>;
}

#[derive(Clone, Debug)]
pub struct DefaultIsmCache {
    value: Arc<RwLock<Option<(H256, Instant)>>>,
    mailbox: Arc<dyn Mailbox>,
}

impl DefaultIsmCache {
    // 10 mins
    const TTL: Duration = Duration::from_secs(60 * 10);

    pub fn new(mailbox: Arc<dyn Mailbox>) -> Self {
        Self {
            value: Arc::new(RwLock::new(None)),
            mailbox,
        }
    }

    pub async fn get(&self) -> Result<H256> {
        let mut value = self.value.write().await;
        let now = Instant::now();
        if value.is_none()
            || value
                .as_ref()
                .is_some_and(|val| val.1.elapsed() > Self::TTL)
        {
            *value = Some((self.mailbox.default_ism().await?, Instant::now()));
        }
        // TODO refactor
        Ok(value.as_ref().unwrap().0.clone())
    }
}

#[derive(Clone, Debug)]
pub struct AppContextClassifier {
    default_ism: DefaultIsmCache,
    app_matching_lists: Vec<(MatchingList, String)>,
}

impl AppContextClassifier {
    pub fn new(destination_mailbox: Arc<dyn Mailbox>) -> Self {
        Self {
            default_ism: DefaultIsmCache::new(destination_mailbox),
            app_matching_lists: vec![],
        }
    }

    pub async fn get_app_context(
        &self,
        message: &HyperlaneMessage,
        root_ism: H256,
    ) -> Result<Option<String>> {
        let default_ism = self.default_ism.get().await?;
        if root_ism == default_ism {
            return Ok(Some("default_ism".to_string()));
        }

        for (matching_list, app_context) in self.app_matching_lists.iter() {
            if matching_list.msg_matches(message, false) {
                return Ok(Some(app_context.clone()));
            }
        }
        Ok(None)
    }
}

#[derive(Clone, new)]
pub struct BaseMetadataBuilder {
    pub(crate) origin_domain: HyperlaneDomain,
    pub(crate) destination_chain_setup: ChainConf,
    origin_prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    origin_validator_announce: Arc<dyn ValidatorAnnounce>,
    allow_local_checkpoint_syncers: bool,
    pub(crate) metrics: Arc<CoreMetrics>,
    db: HyperlaneRocksDB,
    /// ISMs can be structured recursively. We keep track of the depth
    /// of the recursion to avoid infinite loops.
    #[new(default)]
    depth: u32,
    max_depth: u32,
    app_context_classifier: AppContextClassifier,
    // root_ism: H256,
    // metric_app_context: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MessageBaseMetadataBuilder {
    pub message: HyperlaneMessage,
    pub base: BaseMetadataBuilder,
    pub depth: u32,
    pub root_ism: H256,
}

impl AsRef<BaseMetadataBuilder> for MessageBaseMetadataBuilder {
    fn as_ref(&self) -> &BaseMetadataBuilder {
        &self.base
    }
}

impl Debug for BaseMetadataBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MetadataBuilder {{ chain_setup: {:?}, validator_announce: {:?} }}",
            self.destination_chain_setup, self.origin_validator_announce
        )
    }
}

#[async_trait]
impl MetadataBuilder for BaseMetadataBuilder {
    #[instrument(err, skip(self), fields(domain=self.domain().name()))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        metric_app_context: Option<String>,
    ) -> Result<Option<Vec<u8>>> {
        let message_metadata_builder = self.message_metadata_builder(ism_address, message)?;
        message_metadata_builder
            .build_ism_and_metadata(ism_address, message, metric_app_context)
            .await
            .map(|ism_with_metadata| ism_with_metadata.metadata)
    }
}

impl BaseMetadataBuilder {
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.destination_chain_setup.domain
    }

    pub fn clone_with_incremented_depth(&self) -> Result<BaseMetadataBuilder> {
        let mut cloned = self.clone();
        cloned.depth += 1;
        if cloned.depth > cloned.max_depth {
            Err(MetadataBuilderError::MaxDepthExceeded(cloned.depth).into())
        } else {
            Ok(cloned)
        }
    }

    pub async fn get_proof(&self, leaf_index: u32, checkpoint: Checkpoint) -> Result<Proof> {
        const CTX: &str = "When fetching message proof";
        let proof = self
            .origin_prover_sync
            .read()
            .await
            .get_proof(leaf_index, checkpoint.index)
            .context(CTX)?;

        if proof.root() != checkpoint.root {
            info!(
                ?checkpoint,
                canonical_root = ?proof.root(),
                "Could not fetch metadata: checkpoint root does not match canonical root from merkle proof"
            );
        }
        Ok(proof)
    }

    pub async fn highest_known_leaf_index(&self) -> Option<u32> {
        self.origin_prover_sync.read().await.count().checked_sub(1)
    }

    pub async fn get_merkle_leaf_id_by_message_id(&self, message_id: H256) -> Result<Option<u32>> {
        let merkle_leaf = self
            .db
            .retrieve_merkle_leaf_index_by_message_id(&message_id)?;
        Ok(merkle_leaf)
    }

    pub async fn build_ism(&self, address: H256) -> Result<Box<dyn InterchainSecurityModule>> {
        self.destination_chain_setup
            .build_ism(address, &self.metrics)
            .await
    }

    pub async fn build_routing_ism(&self, address: H256) -> Result<Box<dyn RoutingIsm>> {
        self.destination_chain_setup
            .build_routing_ism(address, &self.metrics)
            .await
    }

    pub async fn build_multisig_ism(&self, address: H256) -> Result<Box<dyn MultisigIsm>> {
        self.destination_chain_setup
            .build_multisig_ism(address, &self.metrics)
            .await
    }

    pub async fn build_aggregation_ism(&self, address: H256) -> Result<Box<dyn AggregationIsm>> {
        self.destination_chain_setup
            .build_aggregation_ism(address, &self.metrics)
            .await
    }

    pub async fn build_ccip_read_ism(&self, address: H256) -> Result<Box<dyn CcipReadIsm>> {
        self.destination_chain_setup
            .build_ccip_read_ism(address, &self.metrics)
            .await
    }

    // here
    pub async fn build_checkpoint_syncer(
        &self,
        message: &HyperlaneMessage,
        validators: &[H256],
        // get_latest_index_gauge: Option<fn (validator: H256) -> IntGauge>,
        get_latest_index_gauge: Option<impl Fn(H256) -> GenericGauge<AtomicI64>>,
    ) -> Result<MultisigCheckpointSyncer> {
        let storage_locations = self
            .origin_validator_announce
            .get_announced_storage_locations(validators)
            .await?;

        // Only use the most recently announced location for now.
        let mut checkpoint_syncers: HashMap<H160, Arc<dyn CheckpointSyncer>> = HashMap::new();
        for (&validator, validator_storage_locations) in validators.iter().zip(storage_locations) {
            for storage_location in validator_storage_locations.iter().rev() {
                let Ok(config) = CheckpointSyncerConf::from_str(storage_location) else {
                    debug!(
                        ?validator,
                        ?storage_location,
                        "Could not parse checkpoint syncer config for validator"
                    );
                    continue;
                };

                // If this is a LocalStorage based checkpoint syncer and it's not
                // allowed, ignore it
                if !self.allow_local_checkpoint_syncers
                    && matches!(config, CheckpointSyncerConf::LocalStorage { .. })
                {
                    debug!(
                        ?config,
                        "Ignoring disallowed LocalStorage based checkpoint syncer"
                    );
                    continue;
                }

                // let validator_address = format!("0x{:x}", H160::from(validator));

                // // let latest_index_gauge = metric_labels.as_ref().map(|app_context| self
                // //     .metrics
                // //     .validator_checkpoint_index()
                // //     .with_label_values(&[&self.origin_domain.to_string(), &validator_address.to_lowercase(), app_context])
                // // );

                let latest_index_gauge = None; // get_latest_index_gauge.as_ref().map(|f| f(validator));

                match config.build(latest_index_gauge) {
                    Ok(checkpoint_syncer) => {
                        // found the syncer for this validator
                        checkpoint_syncers.insert(validator.into(), checkpoint_syncer.into());
                        break;
                    }
                    Err(err) => {
                        debug!(
                            error=%err,
                            ?config,
                            ?validator,
                            "Error when loading checkpoint syncer; will attempt to use the next config"
                        );
                    }
                }
            }
            if checkpoint_syncers.get(&validator.into()).is_none() {
                if validator_storage_locations.is_empty() {
                    warn!(?validator, "Validator has not announced any storage locations; see https://docs.hyperlane.xyz/docs/operators/validators/announcing-your-validator");
                } else {
                    warn!(
                        ?validator,
                        ?validator_storage_locations,
                        "No valid checkpoint syncer configs for validator"
                    );
                }
            }
        }
        Ok(MultisigCheckpointSyncer::new(
            checkpoint_syncers,
            self.metrics.clone(),
            self.app_context_classifier
                .get_app_context(message, H256::zero())
                .await?,
        ))
    }

    #[instrument(err, skip(self), fields(domain=self.domain().name()))]
    pub async fn build_ism_and_metadata(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        metric_app_context: Option<String>,
    ) -> Result<IsmWithMetadataAndType> {
        let ism: Box<dyn InterchainSecurityModule> = self
            .build_ism(ism_address)
            .await
            .context("When building ISM")?;

        let module_type = ism
            .module_type()
            .await
            .context("When fetching module type")?;
        let base = self.clone_with_incremented_depth()?;
        let message_base = MessageBaseMetadataBuilder {
            message: message.clone(),
            base: base.clone(),
            depth: base.depth,
            root_ism: H256::zero(),
        };

        let metadata_builder: Box<dyn MetadataBuilder> = match module_type {
            ModuleType::MerkleRootMultisig => {
                Box::new(MerkleRootMultisigMetadataBuilder::new(message_base))
            }
            ModuleType::MessageIdMultisig => {
                Box::new(MessageIdMultisigMetadataBuilder::new(message_base))
            }
            ModuleType::Routing => Box::new(RoutingIsmMetadataBuilder::new(base)),
            ModuleType::Aggregation => Box::new(AggregationIsmMetadataBuilder::new(base)),
            ModuleType::Null => Box::new(NullMetadataBuilder::new()),
            ModuleType::CcipRead => Box::new(CcipReadIsmMetadataBuilder::new(base)),
            _ => return Err(MetadataBuilderError::UnsupportedModuleType(module_type).into()),
        };
        let meta = metadata_builder
            .build(ism_address, message, metric_app_context)
            .await
            .context("When building metadata");
        Ok(IsmWithMetadataAndType {
            ism,
            metadata: meta?,
            module_type,
        })
    }

    pub fn message_metadata_builder(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<MessageBaseMetadataBuilder> {
        Ok(MessageBaseMetadataBuilder {
            message: message.clone(),
            base: self.clone(),
            depth: self.depth,
            root_ism: H256::zero(),
        })
    }
}

impl MessageBaseMetadataBuilder {
    fn clone_with_incremented_depth(&self) -> Result<MessageBaseMetadataBuilder> {
        let mut cloned = self.clone();
        cloned.depth += 1;
        if cloned.depth > cloned.base.max_depth {
            Err(MetadataBuilderError::MaxDepthExceeded(cloned.depth).into())
        } else {
            Ok(cloned)
        }
    }

    #[instrument(err, skip(self), fields(domain=self.base.domain().name()))]
    pub async fn build_ism_and_metadata(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        metric_app_context: Option<String>,
    ) -> Result<IsmWithMetadataAndType> {
        let ism: Box<dyn InterchainSecurityModule> = self
            .base
            .build_ism(ism_address)
            .await
            .context("When building ISM")?;

        let module_type = ism
            .module_type()
            .await
            .context("When fetching module type")?;
        let base = self.base.clone_with_incremented_depth()?;
        let message_base = self.clone_with_incremented_depth()?;
        // let message_base = MessageBaseMetadataBuilder {
        //     message: message.clone(),
        //     base: base.clone(),
        //     depth: base.depth,
        //     root_ism: H256::zero(),
        // };

        let metadata_builder: Box<dyn MetadataBuilder> = match module_type {
            ModuleType::MerkleRootMultisig => {
                Box::new(MerkleRootMultisigMetadataBuilder::new(message_base))
            }
            ModuleType::MessageIdMultisig => {
                Box::new(MessageIdMultisigMetadataBuilder::new(message_base))
            }
            ModuleType::Routing => Box::new(RoutingIsmMetadataBuilder::new(base)),
            ModuleType::Aggregation => Box::new(AggregationIsmMetadataBuilder::new(base)),
            ModuleType::Null => Box::new(NullMetadataBuilder::new()),
            ModuleType::CcipRead => Box::new(CcipReadIsmMetadataBuilder::new(base)),
            _ => return Err(MetadataBuilderError::UnsupportedModuleType(module_type).into()),
        };
        let meta = metadata_builder
            .build(ism_address, message, metric_app_context)
            .await
            .context("When building metadata");
        Ok(IsmWithMetadataAndType {
            ism,
            metadata: meta?,
            module_type,
        })
    }
}

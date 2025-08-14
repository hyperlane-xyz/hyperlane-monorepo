use std::fmt::Debug;
use std::sync::Arc;
use std::time::{Duration, Instant};

use hyperlane_base::cursors::{CursorType, Indexable};
use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_base::settings::{ChainConf, SequenceIndexer, TryFromWithMetrics};
use hyperlane_base::{
    ContractSync, ContractSyncMetrics, ContractSyncer, CoreMetrics, SequenceAwareLogStore,
    SequencedDataContractSync, WatermarkContractSync, WatermarkLogStore,
};
use hyperlane_core::{
    HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, HyperlaneSequenceAwareIndexerStoreReader,
    HyperlaneWatermarkedLogStore, InterchainGasPayment, MerkleTreeInsertion, ValidatorAnnounce,
};
use tokio::sync::RwLock;

use crate::merkle_tree::builder::MerkleTreeBuilder;
use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::settings::GasPaymentEnforcementConf;

type MessageSync = Arc<dyn ContractSyncer<HyperlaneMessage>>;
type InterchainGasPaymentSync = Arc<dyn ContractSyncer<InterchainGasPayment>>;
type MerkleTreeHookSync = Arc<dyn ContractSyncer<MerkleTreeInsertion>>;

pub struct Origin {
    pub database: HyperlaneRocksDB,
    pub domain: HyperlaneDomain,
    pub chain_conf: ChainConf,
    pub validator_announce: Arc<dyn ValidatorAnnounce>,
    pub gas_payment_enforcer: Arc<RwLock<GasPaymentEnforcer>>,
    pub prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    pub message_sync: MessageSync,
    pub interchain_gas_payment_sync: Option<InterchainGasPaymentSync>,
    pub merkle_tree_hook_sync: MerkleTreeHookSync,
}

impl std::fmt::Debug for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Origin {{ domain: {} }}", self.domain.name())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FactoryError {
    #[error("Failed to create validator announce for domain {0}: {1}")]
    ValidatorAnnounce(String, String),
    #[error("Failed to create message sync for domain {0}: {1}")]
    MessageSync(String, String),
    #[error("Failed to create igp sync for domain {0}: {1}")]
    InterchainGasPaymentSync(String, String),
    #[error("Failed to create merkle tree hook sync for domain {0}: {1}")]
    MerkleTreeHookSync(String, String),
}

pub trait Factory {
    async fn create(
        &self,
        domain: HyperlaneDomain,
        chain_conf: &ChainConf,
        gas_payment_enforcement: Vec<GasPaymentEnforcementConf>,
    ) -> Result<Origin, FactoryError>;
}

#[derive(Clone, Debug)]
pub struct OriginFactory {
    db: DB,
    core_metrics: Arc<CoreMetrics>,
    sync_metrics: Arc<ContractSyncMetrics>,
    advanced_log_meta: bool,
    tx_id_indexing_enabled: bool,
    igp_indexing_enabled: bool,
}

impl OriginFactory {
    pub fn new(
        db: DB,
        core_metrics: Arc<CoreMetrics>,
        sync_metrics: Arc<ContractSyncMetrics>,
        advanced_log_meta: bool,
        tx_id_indexing_enabled: bool,
        igp_indexing_enabled: bool,
    ) -> Self {
        Self {
            db,
            core_metrics,
            sync_metrics,
            advanced_log_meta,
            tx_id_indexing_enabled,
            igp_indexing_enabled,
        }
    }
}

impl Factory for OriginFactory {
    async fn create(
        &self,
        domain: HyperlaneDomain,
        chain_conf: &ChainConf,
        gas_payment_enforcement: Vec<GasPaymentEnforcementConf>,
    ) -> Result<Origin, FactoryError> {
        let db = HyperlaneRocksDB::new(&domain, self.db.clone());

        let validator_announce = {
            let start_entity_init = Instant::now();
            let res = self.init_validator_announce(chain_conf, &domain).await?;
            self.measure(&domain, "validator_announce", start_entity_init.elapsed());
            res
        };

        // need one of these per origin chain due to the database scoping even though
        // the config itself is the same
        // TODO: maybe use a global one moving forward?
        let gas_payment_enforcer = {
            let start_entity_init = Instant::now();
            let res = self
                .init_gas_payment_enforcer(gas_payment_enforcement, db.clone())
                .await?;
            self.measure(&domain, "gas_payment_enforcer", start_entity_init.elapsed());
            res
        };

        let prover_sync = {
            let start_entity_init = Instant::now();
            let res = Self::init_prover_sync().await?;
            self.measure(&domain, "prover_sync", start_entity_init.elapsed());
            res
        };

        let hyperlane_db = Arc::new(db.clone());
        let message_sync = {
            let start_entity_init = Instant::now();
            let res = self
                .init_message_sync(&domain, chain_conf, hyperlane_db.clone())
                .await?;
            self.measure(&domain, "message_sync", start_entity_init.elapsed());
            res
        };

        let interchain_gas_payment_sync = if self.igp_indexing_enabled {
            let igp_sync = {
                let start_entity_init = Instant::now();
                let res = self
                    .init_igp_sync(&domain, chain_conf, hyperlane_db.clone())
                    .await?;
                self.measure(
                    &domain,
                    "interchain_gas_payment_sync",
                    start_entity_init.elapsed(),
                );
                res
            };
            Some(igp_sync)
        } else {
            None
        };

        let merkle_tree_hook_sync = {
            let start_entity_init = Instant::now();
            let res = self
                .init_merkle_tree_hook_sync(&domain, chain_conf, hyperlane_db.clone())
                .await?;
            self.measure(
                &domain,
                "merkle_tree_hook_sync",
                start_entity_init.elapsed(),
            );
            res
        };

        let origin = Origin {
            database: db,
            domain,
            chain_conf: chain_conf.clone(),
            validator_announce,
            gas_payment_enforcer: Arc::new(RwLock::new(gas_payment_enforcer)),
            prover_sync: Arc::new(RwLock::new(prover_sync)),
            message_sync,
            interchain_gas_payment_sync,
            merkle_tree_hook_sync,
        };
        Ok(origin)
    }
}

impl OriginFactory {
    fn measure(&self, domain: &HyperlaneDomain, entity: &str, latency: Duration) {
        let chain_init_latency_labels = [domain.name(), "origin", entity];
        self.core_metrics
            .chain_init_latency()
            .with_label_values(&chain_init_latency_labels)
            .set(latency.as_millis() as i64);
    }

    async fn init_validator_announce(
        &self,
        chain_conf: &ChainConf,
        domain: &HyperlaneDomain,
    ) -> Result<Arc<dyn ValidatorAnnounce>, FactoryError> {
        let validator_announce = chain_conf
            .build_validator_announce(&self.core_metrics)
            .await
            .map_err(|err| FactoryError::ValidatorAnnounce(domain.to_string(), err.to_string()))?;
        Ok(validator_announce.into())
    }

    async fn init_prover_sync() -> Result<MerkleTreeBuilder, FactoryError> {
        let prover_sync = MerkleTreeBuilder::new();
        Ok(prover_sync)
    }

    async fn init_gas_payment_enforcer(
        &self,
        gas_payment_enforcement: Vec<GasPaymentEnforcementConf>,
        db: HyperlaneRocksDB,
    ) -> Result<GasPaymentEnforcer, FactoryError> {
        Ok(GasPaymentEnforcer::new(gas_payment_enforcement, db))
    }

    async fn init_message_sync(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
        db: Arc<HyperlaneRocksDB>,
    ) -> Result<MessageSync, FactoryError> {
        match HyperlaneMessage::indexing_cursor(domain.domain_protocol()) {
            CursorType::SequenceAware => Self::build_sequenced_contract_sync(
                domain,
                chain_conf,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                self.tx_id_indexing_enabled,
            )
            .await
            .map(|r| r as Arc<dyn ContractSyncer<_>>)
            .map_err(|err| FactoryError::MessageSync(domain.to_string(), err.to_string())),
            CursorType::RateLimited => Self::build_watermark_contract_sync(
                domain,
                chain_conf,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                self.tx_id_indexing_enabled,
            )
            .await
            .map(|r| r as Arc<dyn ContractSyncer<_>>)
            .map_err(|err| FactoryError::MessageSync(domain.to_string(), err.to_string())),
        }
    }

    async fn init_igp_sync(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
        db: Arc<HyperlaneRocksDB>,
    ) -> Result<InterchainGasPaymentSync, FactoryError> {
        match InterchainGasPayment::indexing_cursor(domain.domain_protocol()) {
            CursorType::SequenceAware => Self::build_sequenced_contract_sync(
                domain,
                chain_conf,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                false,
            )
            .await
            .map(|r| r as Arc<dyn ContractSyncer<_>>)
            .map_err(|err| {
                FactoryError::InterchainGasPaymentSync(domain.to_string(), err.to_string())
            }),
            CursorType::RateLimited => Self::build_watermark_contract_sync(
                domain,
                chain_conf,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                false,
            )
            .await
            .map(|r| r as Arc<dyn ContractSyncer<_>>)
            .map_err(|err| {
                FactoryError::InterchainGasPaymentSync(domain.to_string(), err.to_string())
            }),
        }
    }

    async fn init_merkle_tree_hook_sync(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
        db: Arc<HyperlaneRocksDB>,
    ) -> Result<MerkleTreeHookSync, FactoryError> {
        match MerkleTreeInsertion::indexing_cursor(domain.domain_protocol()) {
            CursorType::SequenceAware => Self::build_sequenced_contract_sync(
                domain,
                chain_conf,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                false,
            )
            .await
            .map(|r| r as Arc<dyn ContractSyncer<_>>)
            .map_err(|err| FactoryError::MerkleTreeHookSync(domain.to_string(), err.to_string())),
            CursorType::RateLimited => Self::build_watermark_contract_sync(
                domain,
                chain_conf,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                false,
            )
            .await
            .map(|r| r as Arc<dyn ContractSyncer<_>>)
            .map_err(|err| FactoryError::MerkleTreeHookSync(domain.to_string(), err.to_string())),
        }
    }

    async fn build_sequenced_contract_sync<T, S>(
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
        metrics: &CoreMetrics,
        sync_metrics: &ContractSyncMetrics,
        store: Arc<S>,
        advanced_log_meta: bool,
        broadcast_sender_enabled: bool,
    ) -> eyre::Result<Arc<SequencedDataContractSync<T>>>
    where
        T: Indexable + Debug,
        SequenceIndexer<T>: TryFromWithMetrics<ChainConf>,
        S: HyperlaneLogStore<T> + HyperlaneSequenceAwareIndexerStoreReader<T> + 'static,
    {
        // Currently, all indexers are of the `SequenceIndexer` type
        let indexer =
            SequenceIndexer::<T>::try_from_with_metrics(chain_conf, metrics, advanced_log_meta)
                .await?;
        Ok(Arc::new(ContractSync::new(
            domain.clone(),
            store.clone() as SequenceAwareLogStore<_>,
            indexer,
            sync_metrics.clone(),
            broadcast_sender_enabled,
        )))
    }

    async fn build_watermark_contract_sync<T, S>(
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
        metrics: &CoreMetrics,
        sync_metrics: &ContractSyncMetrics,
        store: Arc<S>,
        advanced_log_meta: bool,
        broadcast_sender_enabled: bool,
    ) -> eyre::Result<Arc<WatermarkContractSync<T>>>
    where
        T: Indexable + Debug,
        SequenceIndexer<T>: TryFromWithMetrics<ChainConf>,
        S: HyperlaneLogStore<T> + HyperlaneWatermarkedLogStore<T> + 'static,
    {
        let indexer =
            SequenceIndexer::<T>::try_from_with_metrics(chain_conf, metrics, advanced_log_meta)
                .await?;
        Ok(Arc::new(ContractSync::new(
            domain.clone(),
            store.clone() as WatermarkLogStore<_>,
            indexer,
            sync_metrics.clone(),
            broadcast_sender_enabled,
        )))
    }
}

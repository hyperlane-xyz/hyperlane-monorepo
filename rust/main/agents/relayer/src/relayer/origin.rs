use std::sync::Arc;
use std::time::{Duration, Instant};

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_base::settings::{ChainConf, IndexSettings};
use hyperlane_base::{ContractSyncMetrics, ContractSyncer, CoreMetrics};
use hyperlane_core::{
    HyperlaneDomain, HyperlaneMessage, InterchainGasPayment, Mailbox, MerkleTreeInsertion,
    ValidatorAnnounce,
};
use hyperlane_operation_verifier::ApplicationOperationVerifier;
use tokio::sync::RwLock;

use crate::merkle_tree::builder::MerkleTreeBuilder;
use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::settings::RelayerSettings;

type MessageSync = Arc<dyn ContractSyncer<HyperlaneMessage>>;
type InterchainGasPaymentSync = Arc<dyn ContractSyncer<InterchainGasPayment>>;
type MerkleTreeHookSync = Arc<dyn ContractSyncer<MerkleTreeInsertion>>;

#[derive(Clone)]
pub struct Origin {
    pub database: HyperlaneRocksDB,
    pub domain: HyperlaneDomain,
    pub index_settings: IndexSettings,
    pub application_operation_verifier: Arc<dyn ApplicationOperationVerifier>,
    pub mailbox: Arc<dyn Mailbox>,
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
    #[error("Failed to create chain setup for domain {0}: {1}")]
    ChainSetupCreationFailed(String, String),
    #[error("Failed to create application operation verifier for domain {0}: {1}")]
    ApplicationOperationVerifierCreationFailed(String, String),
    #[error("Failed to create mailbox for domain {0}: {1}")]
    MailboxCreationFailed(String, String),
    #[error("Failed to create validator announce for domain {0}: {1}")]
    ValidatorAnnounceCreationFailed(String, String),
    #[error("Failed to create message sync for domain {0}: {1}")]
    MessageSyncCreationFailed(String, String),
    #[error("Failed to create igp sync for domain {0}: {1}")]
    InterchainGasPaymentSyncCreationFailed(String, String),
    #[error("Failed to create merkle tree hook sync for domain {0}: {1}")]
    MerkleTreeHookSyncCreationFailed(String, String),
    #[error("Missing index settings for domain {0}")]
    IndexSettingsNotFound(String),
}

pub trait Factory {
    async fn create(
        &self,
        settings: &RelayerSettings,
        domain: HyperlaneDomain,
    ) -> Result<Origin, FactoryError>;
}

#[derive(Clone, Debug)]
pub struct OriginFactory {
    db: DB,
    core_metrics: Arc<CoreMetrics>,
    sync_metrics: Arc<ContractSyncMetrics>,
    advanced_log_meta: bool,
}

impl OriginFactory {
    pub fn new(
        db: DB,
        core_metrics: Arc<CoreMetrics>,
        sync_metrics: Arc<ContractSyncMetrics>,
        advanced_log_meta: bool,
    ) -> Self {
        Self {
            db,
            core_metrics,
            sync_metrics,
            advanced_log_meta,
        }
    }
}

impl Factory for OriginFactory {
    async fn create(
        &self,
        settings: &RelayerSettings,
        domain: HyperlaneDomain,
    ) -> Result<Origin, FactoryError> {
        let db = HyperlaneRocksDB::new(&domain, self.db.clone());

        let index_settings = settings
            .chains
            .get(&domain)
            .ok_or_else(|| FactoryError::IndexSettingsNotFound(domain.to_string()))?
            .index_settings();

        let start_entity_init = Instant::now();
        let application_operation_verifier = self
            .init_application_operation_verifier(settings, &domain)
            .await?;
        self.measure(
            &domain,
            "application_operation_verifier",
            start_entity_init.elapsed(),
        );

        let start_entity_init = Instant::now();
        let mailbox = self.init_mailbox(settings, &domain).await?;
        self.measure(&domain, "mailbox", start_entity_init.elapsed());

        let start_entity_init = Instant::now();
        let validator_announce = self.init_validator_announce(settings, &domain).await?;
        self.measure(&domain, "validator_announce", start_entity_init.elapsed());

        // need one of these per origin chain due to the database scoping even though
        // the config itself is the same
        // TODO: maybe use a global one moving forward?
        let start_entity_init = Instant::now();
        let gas_payment_enforcer = self.init_gas_payment_enforcer(settings, db.clone()).await?;
        self.measure(&domain, "gas_payment_enforcer", start_entity_init.elapsed());

        let start_entity_init = Instant::now();
        let prover_sync = Self::init_prover_sync().await?;
        self.measure(&domain, "prover_sync", start_entity_init.elapsed());

        let hyperlane_db = Arc::new(db.clone());
        let start_entity_init = Instant::now();
        let message_sync = self
            .init_message_sync(settings, &domain, hyperlane_db.clone())
            .await?;
        self.measure(&domain, "message_sync", start_entity_init.elapsed());

        let interchain_gas_payment_sync = if settings.igp_indexing_enabled {
            let start_entity_init = Instant::now();
            let igp_sync = self
                .init_igp_sync(settings, &domain, hyperlane_db.clone())
                .await?;
            self.measure(
                &domain,
                "interchain_gas_payment_sync",
                start_entity_init.elapsed(),
            );
            Some(igp_sync)
        } else {
            None
        };

        let start_entity_init = Instant::now();
        let merkle_tree_hook_sync = self
            .init_merkle_tree_hook_sync(settings, &domain, hyperlane_db.clone())
            .await?;
        self.measure(
            &domain,
            "merkle_tree_hook_sync",
            start_entity_init.elapsed(),
        );

        let origin = Origin {
            database: db,
            domain,
            index_settings,
            application_operation_verifier,
            mailbox,
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

    fn init_chain_setup<'a>(
        settings: &'a RelayerSettings,
        domain: &HyperlaneDomain,
    ) -> Result<&'a ChainConf, FactoryError> {
        let setup = settings.chain_setup(domain).map_err(|err| {
            FactoryError::ChainSetupCreationFailed(domain.to_string(), err.to_string())
        })?;
        Ok(setup)
    }

    async fn init_application_operation_verifier(
        &self,
        settings: &RelayerSettings,
        domain: &HyperlaneDomain,
    ) -> Result<Arc<dyn ApplicationOperationVerifier>, FactoryError> {
        let setup = Self::init_chain_setup(settings, domain)?;
        let application_operation_verifier = setup
            .build_application_operation_verifier(&self.core_metrics)
            .await
            .map_err(|err| {
                FactoryError::ApplicationOperationVerifierCreationFailed(
                    domain.to_string(),
                    err.to_string(),
                )
            })?;
        Ok(application_operation_verifier.into())
    }

    async fn init_mailbox(
        &self,
        settings: &RelayerSettings,
        domain: &HyperlaneDomain,
    ) -> Result<Arc<dyn Mailbox>, FactoryError> {
        let setup = Self::init_chain_setup(settings, domain)?;
        let mailbox = setup
            .build_mailbox(&self.core_metrics)
            .await
            .map_err(|err| {
                FactoryError::MailboxCreationFailed(domain.to_string(), err.to_string())
            })?;
        Ok(mailbox.into())
    }

    async fn init_validator_announce(
        &self,
        settings: &RelayerSettings,
        domain: &HyperlaneDomain,
    ) -> Result<Arc<dyn ValidatorAnnounce>, FactoryError> {
        let setup = Self::init_chain_setup(settings, domain)?;
        let validator_announce = setup
            .build_validator_announce(&self.core_metrics)
            .await
            .map_err(|err| {
                FactoryError::ValidatorAnnounceCreationFailed(domain.to_string(), err.to_string())
            })?;
        Ok(validator_announce.into())
    }

    async fn init_prover_sync() -> Result<MerkleTreeBuilder, FactoryError> {
        let prover_sync = MerkleTreeBuilder::new();
        Ok(prover_sync)
    }

    async fn init_gas_payment_enforcer(
        &self,
        settings: &RelayerSettings,
        db: HyperlaneRocksDB,
    ) -> Result<GasPaymentEnforcer, FactoryError> {
        Ok(GasPaymentEnforcer::new(
            settings.gas_payment_enforcement.clone(),
            db,
        ))
    }

    async fn init_message_sync(
        &self,
        settings: &RelayerSettings,
        domain: &HyperlaneDomain,
        db: Arc<HyperlaneRocksDB>,
    ) -> Result<MessageSync, FactoryError> {
        let sync = settings
            .contract_sync(
                domain,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                settings.tx_id_indexing_enabled,
            )
            .await
            .map_err(|err| {
                FactoryError::MessageSyncCreationFailed(domain.to_string(), err.to_string())
            })?;

        Ok(sync)
    }

    async fn init_igp_sync(
        &self,
        settings: &RelayerSettings,
        domain: &HyperlaneDomain,
        db: Arc<HyperlaneRocksDB>,
    ) -> Result<InterchainGasPaymentSync, FactoryError> {
        let sync = settings
            .contract_sync(
                domain,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                // We currently don't use any of the broadcasted messages
                // from this. So we don't need it enabled
                false,
            )
            .await
            .map_err(|err| {
                FactoryError::InterchainGasPaymentSyncCreationFailed(
                    domain.to_string(),
                    err.to_string(),
                )
            })?;

        Ok(sync)
    }

    async fn init_merkle_tree_hook_sync(
        &self,
        settings: &RelayerSettings,
        domain: &HyperlaneDomain,
        db: Arc<HyperlaneRocksDB>,
    ) -> Result<MerkleTreeHookSync, FactoryError> {
        let sync = settings
            .contract_sync(
                domain,
                &self.core_metrics,
                &self.sync_metrics,
                db,
                self.advanced_log_meta,
                false,
            )
            .await
            .map_err(|err| {
                FactoryError::MerkleTreeHookSyncCreationFailed(domain.to_string(), err.to_string())
            })?;

        Ok(sync)
    }
}

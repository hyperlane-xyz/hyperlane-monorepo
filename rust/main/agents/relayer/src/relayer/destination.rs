use std::fmt::Debug;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::warn;

use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::{db::DB, settings::ChainConf, CoreMetrics};
use hyperlane_core::{HyperlaneDomain, HyperlaneDomainProtocol, Mailbox, SubmitterType};
use hyperlane_ethereum::Signers;
use hyperlane_operation_verifier::ApplicationOperationVerifier;
use lander::{
    DatabaseOrPath, Dispatcher, DispatcherEntrypoint, DispatcherMetrics, DispatcherSettings,
};

pub struct Destination {
    pub domain: HyperlaneDomain,
    pub application_operation_verifier: Arc<dyn ApplicationOperationVerifier>,
    pub chain_conf: ChainConf,
    pub database: HyperlaneRocksDB,
    pub dispatcher_entrypoint: Option<DispatcherEntrypoint>,
    pub dispatcher: Option<Dispatcher>,
    pub mailbox: Arc<dyn Mailbox>,
    pub ccip_signer: Option<Signers>,
}

impl Debug for Destination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Destination {{ domain: {} }}", self.domain.name())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FactoryError {
    #[error("Failed to create application operation verifier for domain {0}: {1}")]
    ApplicationOperationVerifierCreationFailed(String, String),
    #[error("Failed to create dispatcher for domain {0}: {1}")]
    DispatcherCreationFailed(String, String),
    #[error("Failed to create dispatcher entrypoint for domain {0}: {1}")]
    DispatcherEntrypointCreationFailed(String, String),
    #[error("Failed to create mailbox for domain {0}: {1}")]
    MailboxCreationFailed(String, String),
    #[error("Failed to create destination for domain {0} due to missing configuration")]
    MissingConfiguration(String),
}

pub trait Factory {
    async fn create(
        &self,
        domain: HyperlaneDomain,
        chain_conf: ChainConf,
        dispatcher_metrics: DispatcherMetrics,
    ) -> Result<Destination, FactoryError>;
}

pub struct DestinationFactory {
    db: DB,
    core_metrics: Arc<CoreMetrics>,
}

impl DestinationFactory {
    pub fn new(db: DB, core_metrics: Arc<CoreMetrics>) -> Self {
        Self { db, core_metrics }
    }
}

impl Factory for DestinationFactory {
    async fn create(
        &self,
        domain: HyperlaneDomain,
        chain_conf: ChainConf,
        dispatcher_metrics: DispatcherMetrics,
    ) -> Result<Destination, FactoryError> {
        let application_operation_verifier = self
            .init_application_operation_verifier(&domain, &chain_conf)
            .await?;

        let ccip_signer = self.init_ccip_signer(&domain, &chain_conf).await;

        let database = HyperlaneRocksDB::new(&domain, self.db.clone());

        let (dispatcher_entrypoint, dispatcher) = self
            .init_dispatcher_and_entrypoint(&domain, chain_conf.clone(), dispatcher_metrics)
            .await?;

        let mailbox = self.init_mailbox(&domain, &chain_conf).await?;

        let destination = Destination {
            domain,
            application_operation_verifier,
            chain_conf,
            database,
            dispatcher_entrypoint,
            dispatcher,
            mailbox,
            ccip_signer,
        };

        Ok(destination)
    }
}

impl DestinationFactory {
    async fn init_application_operation_verifier(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
    ) -> Result<Arc<dyn ApplicationOperationVerifier>, FactoryError> {
        let start_entity_init = Instant::now();
        let verifier = chain_conf
            .build_application_operation_verifier(self.core_metrics.as_ref())
            .await
            .map_err(|e| {
                FactoryError::ApplicationOperationVerifierCreationFailed(
                    domain.to_string(),
                    e.to_string(),
                )
            })?
            .into();
        self.measure(
            domain,
            "application_operation_verifier",
            start_entity_init.elapsed(),
        );

        Ok(verifier)
    }

    async fn init_ccip_signer(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
    ) -> Option<Signers> {
        let start_entity_init = Instant::now();

        if !matches!(domain.domain_protocol(), HyperlaneDomainProtocol::Ethereum) {
            return None;
        }

        let signer_conf = chain_conf.signer.clone()?;

        let signer = signer_conf
            .build::<Signers>()
            .await
            .map_err(|e| {
                warn!(error = ?e, "Failed to build Ethereum signer for CCIP-read ISM.");
                e
            })
            .ok();

        self.measure(domain, "ccip_signers", start_entity_init.elapsed());

        signer
    }

    async fn init_dispatcher_and_entrypoint(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: ChainConf,
        dispatcher_metrics: DispatcherMetrics,
    ) -> Result<(Option<DispatcherEntrypoint>, Option<Dispatcher>), FactoryError> {
        if chain_conf.submitter != SubmitterType::Lander {
            return Ok((None, None));
        }

        let dispatcher_settings = DispatcherSettings {
            chain_conf,
            raw_chain_conf: Default::default(),
            domain: domain.clone(),
            db: DatabaseOrPath::Database(self.db.clone()),
            metrics: self.core_metrics.clone(),
        };

        let mut start_entity_init = Instant::now();
        let dispatcher_entrypoint = DispatcherEntrypoint::try_from_settings(
            dispatcher_settings.clone(),
            dispatcher_metrics.clone(),
        )
        .await
        .map_err(|e| {
            FactoryError::DispatcherEntrypointCreationFailed(domain.to_string(), e.to_string())
        })?;
        self.measure(domain, "dispatcher_entrypoint", start_entity_init.elapsed());

        start_entity_init = Instant::now();
        let dispatcher = Dispatcher::try_from_settings(
            dispatcher_settings.clone(),
            domain.to_string(),
            dispatcher_metrics.clone(),
        )
        .await
        .map_err(|e| FactoryError::DispatcherCreationFailed(domain.to_string(), e.to_string()))?;
        self.measure(domain, "dispatcher", start_entity_init.elapsed());

        Ok((Some(dispatcher_entrypoint), Some(dispatcher)))
    }

    async fn init_mailbox(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: &ChainConf,
    ) -> Result<Arc<dyn Mailbox>, FactoryError> {
        let start_entity_init = Instant::now();
        let mailbox = chain_conf
            .build_mailbox(self.core_metrics.as_ref())
            .await
            .map_err(|e| FactoryError::MailboxCreationFailed(domain.to_string(), e.to_string()))?
            .into();
        self.measure(domain, "mailbox", start_entity_init.elapsed());

        Ok(mailbox)
    }

    fn measure(&self, domain: &HyperlaneDomain, entity: &str, latency: Duration) {
        let chain_init_latency_labels = [domain.name(), "destination", entity];
        self.core_metrics
            .chain_init_latency()
            .with_label_values(&chain_init_latency_labels)
            .set(latency.as_millis() as i64);
    }
}

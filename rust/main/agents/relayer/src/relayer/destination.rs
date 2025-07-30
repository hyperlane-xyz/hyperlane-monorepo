use std::sync::Arc;
use std::time::{Duration, Instant};

use hyperlane_base::db::DB;
use hyperlane_base::settings::ChainConf;
use hyperlane_base::CoreMetrics;
use hyperlane_core::{HyperlaneDomain, Mailbox, SubmitterType};
use hyperlane_operation_verifier::ApplicationOperationVerifier;
use lander::{
    DatabaseOrPath, Dispatcher, DispatcherEntrypoint, DispatcherMetrics, DispatcherSettings,
};

pub struct Destination {
    pub domain: HyperlaneDomain,
    pub application_operation_verifier: Arc<dyn ApplicationOperationVerifier>,
    pub dispatcher_entrypoint: Option<DispatcherEntrypoint>,
    pub dispatcher: Option<Dispatcher>,
    pub mailbox: Arc<dyn Mailbox>,
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

        let (dispatcher_entrypoint, dispatcher) = self
            .init_dispatcher_and_entrypoint(&domain, chain_conf.clone(), dispatcher_metrics)
            .await?;

        let mailbox = self.init_mailbox(&domain, &chain_conf).await?;

        let destination = Destination {
            domain,
            application_operation_verifier,
            dispatcher_entrypoint,
            dispatcher,
            mailbox,
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

        Ok(verifier)
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
        let mailbox = chain_conf
            .build_mailbox(self.core_metrics.as_ref())
            .await
            .map_err(|e| FactoryError::MailboxCreationFailed(domain.to_string(), e.to_string()))?
            .into();

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

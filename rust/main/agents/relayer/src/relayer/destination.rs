use std::sync::Arc;
use std::time::{Duration, Instant};

use hyperlane_base::db::DB;
use hyperlane_base::settings::ChainConf;
use hyperlane_base::CoreMetrics;
use hyperlane_core::{HyperlaneDomain, SubmitterType};
use lander::{
    DatabaseOrPath, Dispatcher, DispatcherEntrypoint, DispatcherMetrics, DispatcherSettings,
};

pub struct Destination {
    pub domain: HyperlaneDomain,
    pub dispatcher_entrypoint: Option<DispatcherEntrypoint>,
    pub dispatcher: Option<Dispatcher>,
}

#[derive(Debug, thiserror::Error)]
pub enum FactoryError {
    #[error("Failed to create dispatcher for domain {0}: {1}")]
    DispatcherCreationFailed(String, String),
    #[error("Failed to create dispatcher entrypoint for domain {0}: {0}")]
    DispatcherEntrypointCreationFailed(String, String),
}

pub trait Factory {
    async fn create(
        &self,
        domain: HyperlaneDomain,
        chain_conf: ChainConf,
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
    ) -> Result<Destination, FactoryError> {
        let (dispatcher_entrypoint, dispatcher) = self
            .init_dispatcher_and_entrypoint(&domain, chain_conf)
            .await?;

        let destination = Destination {
            domain,
            dispatcher_entrypoint,
            dispatcher,
        };

        Ok(destination)
    }
}

impl DestinationFactory {
    async fn init_dispatcher_and_entrypoint(
        &self,
        domain: &HyperlaneDomain,
        chain_conf: ChainConf,
    ) -> Result<(Option<DispatcherEntrypoint>, Option<Dispatcher>), FactoryError> {
        if chain_conf.submitter != SubmitterType::Lander {
            return Ok((None, None));
        }

        let dispatcher_metrics = DispatcherMetrics::new(self.core_metrics.registry())
            .expect("Creating dispatcher metrics is infallible");

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

    fn measure(&self, domain: &HyperlaneDomain, entity: &str, latency: Duration) {
        let chain_init_latency_labels = [domain.name(), "destination", entity];
        self.core_metrics
            .chain_init_latency()
            .with_label_values(&chain_init_latency_labels)
            .set(latency.as_millis() as i64);
    }
}

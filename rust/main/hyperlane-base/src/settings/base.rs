use std::{collections::HashMap, fmt::Debug, hash::Hash, sync::Arc};

use eyre::{eyre, Context, Result};
use futures_util::future::join_all;

use hyperlane_core::{
    HyperlaneDomain, HyperlaneLogStore, HyperlaneProvider,
    HyperlaneSequenceAwareIndexerStoreReader, HyperlaneWatermarkedLogStore, InterchainGasPaymaster,
    Mailbox, MerkleTreeHook, MultisigIsm, SequenceAwareIndexer, ValidatorAnnounce, H256,
};
use hyperlane_operation_verifier::ApplicationOperationVerifier;

use crate::{
    cursors::{CursorType, Indexable},
    server::Server,
    settings::{chains::ChainConf, trace::TracingConfig},
    ContractSync, ContractSyncMetrics, ContractSyncer, CoreMetrics, HyperlaneAgentCore,
    SequenceAwareLogStore, SequencedDataContractSync, WatermarkContractSync, WatermarkLogStore,
};

use super::TryFromWithMetrics;

/// Settings. Usually this should be treated as a base config and used as
/// follows:
///
/// ```ignore
/// use hyperlane_base::*;
/// use serde::Deserialize;
///
/// pub struct OtherSettings { /* anything */ };
///
/// #[derive(Debug, Deserialize)]
/// pub struct MySettings {
///     #[serde(flatten)]
///     base_settings: Settings,
///     #[serde(flatten)]
///     other_settings: (),
/// }
///
/// // Make sure to define MySettings::new()
/// impl MySettings {
///     fn new() -> Self {
///         unimplemented!()
///     }
/// }
/// ```
#[derive(Debug, Default, Clone)]
pub struct Settings {
    /// Configuration for contracts on each chain
    pub chains: HashMap<String, ChainConf>,
    /// Port to listen for prometheus scrape requests
    pub metrics_port: u16,
    /// The tracing configuration
    pub tracing: TracingConfig,
}

impl Settings {
    /// Generate an agent core
    pub fn build_hyperlane_core(&self, metrics: Arc<CoreMetrics>) -> HyperlaneAgentCore {
        HyperlaneAgentCore {
            metrics,
            settings: self.clone(),
        }
    }

    /// Try to get a MultisigIsm
    pub async fn build_multisig_ism(
        &self,
        domain: &HyperlaneDomain,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MultisigIsm>> {
        let setup = self
            .chain_setup(domain)
            .with_context(|| format!("Building multisig ism for {domain}"))?;
        setup.build_multisig_ism(address, metrics).await
    }

    /// Try to get the chain configuration for the given domain.
    pub fn chain_setup(&self, domain: &HyperlaneDomain) -> Result<&ChainConf> {
        self.chains
            .get(domain.name())
            .ok_or_else(|| eyre!("No chain setup found for {domain}"))
    }

    /// Try to get the domain for a given chain by name.
    pub fn lookup_domain(&self, chain_name: &str) -> Result<HyperlaneDomain> {
        self.chains
            .get(chain_name)
            .ok_or_else(|| eyre!("No chain setup found for {chain_name}"))
            .map(|c| c.domain.clone())
    }

    /// Create the core metrics from the settings given the name of the agent.
    pub fn metrics(&self, name: &str) -> Result<Arc<CoreMetrics>> {
        Ok(Arc::new(CoreMetrics::new(
            name,
            self.metrics_port,
            prometheus::Registry::new(),
        )?))
    }

    /// Create the server from the settings given the name of the agent.
    pub fn server(&self, core_metrics: Arc<CoreMetrics>) -> Result<Arc<Server>> {
        Ok(Arc::new(Server::new(self.metrics_port, core_metrics)))
    }

    /// Private to preserve linearity of AgentCore::from_settings -- creating an
    /// agent consumes the settings.
    fn clone(&self) -> Self {
        Self {
            chains: self.chains.clone(),
            metrics_port: self.metrics_port,
            tracing: self.tracing.clone(),
        }
    }
}

/// Generate a call to ChainSetup for the given builder
macro_rules! build_chain_conf_fns {
    ($singular:ident, $plural:ident -> $ret:ty) => {
        /// Delegates building to ChainSetup
        pub async fn $singular(
            &self,
            domain: &HyperlaneDomain,
            metrics: &CoreMetrics,
        ) -> eyre::Result<Box<$ret>> {
            let setup = self.chain_setup(domain)?;
            setup.$singular(metrics).await
        }

        /// Builds a contract for each domain
        pub async fn $plural(
            &self,
            domains: impl Iterator<Item = &HyperlaneDomain>,
            metrics: &CoreMetrics,
        ) -> HashMap<HyperlaneDomain, eyre::Result<Arc<$ret>>> {
            join_all(domains.map(|d| async { (d.clone(), self.$singular(d, metrics).await) }))
                .await
                .into_iter()
                .map(|(d, future)| (d, future.map(|f| Arc::from(f))))
                .collect()
        }
    };
}

type SequenceIndexer<T> = Arc<dyn SequenceAwareIndexer<T>>;

impl Settings {
    build_chain_conf_fns!(build_application_operation_verifier, build_application_operation_verifiers -> dyn ApplicationOperationVerifier);
    build_chain_conf_fns!(build_interchain_gas_paymaster, build_interchain_gas_paymasters -> dyn InterchainGasPaymaster);
    build_chain_conf_fns!(build_mailbox, build_mailboxes -> dyn Mailbox);
    build_chain_conf_fns!(build_merkle_tree_hook, build_merkle_tree_hooks -> dyn MerkleTreeHook);
    build_chain_conf_fns!(build_provider, build_providers -> dyn HyperlaneProvider);
    build_chain_conf_fns!(build_validator_announce, build_validator_announces -> dyn ValidatorAnnounce);

    /// Build a contract sync for type `T` using log store `S`
    pub async fn sequenced_contract_sync<T, S>(
        &self,
        domain: &HyperlaneDomain,
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
        let setup = self.chain_setup(domain)?;
        // Currently, all indexers are of the `SequenceIndexer` type
        let indexer =
            SequenceIndexer::<T>::try_from_with_metrics(setup, metrics, advanced_log_meta).await?;
        Ok(Arc::new(ContractSync::new(
            domain.clone(),
            store.clone() as SequenceAwareLogStore<_>,
            indexer,
            sync_metrics.clone(),
            broadcast_sender_enabled,
        )))
    }

    /// Build a contract sync for type `T` using log store `S`
    pub async fn watermark_contract_sync<T, S>(
        &self,
        domain: &HyperlaneDomain,
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
        let setup = self.chain_setup(domain)?;
        // Currently, all indexers are of the `SequenceIndexer` type
        let indexer =
            SequenceIndexer::<T>::try_from_with_metrics(setup, metrics, advanced_log_meta).await?;
        Ok(Arc::new(ContractSync::new(
            domain.clone(),
            store.clone() as WatermarkLogStore<_>,
            indexer,
            sync_metrics.clone(),
            broadcast_sender_enabled,
        )))
    }

    /// Build multiple contract syncs.
    /// All contracts have to implement both sequenced and
    /// watermark trait bounds
    pub async fn contract_syncs<T, S>(
        &self,
        domains: impl Iterator<Item = &HyperlaneDomain>,
        metrics: &CoreMetrics,
        sync_metrics: &ContractSyncMetrics,
        stores: HashMap<HyperlaneDomain, Arc<S>>,
        advanced_log_meta: bool,
        broadcast_sender_enabled: bool,
    ) -> Result<HashMap<HyperlaneDomain, Arc<dyn ContractSyncer<T>>>>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
        SequenceIndexer<T>: TryFromWithMetrics<ChainConf>,
        S: HyperlaneLogStore<T>
            + HyperlaneSequenceAwareIndexerStoreReader<T>
            + HyperlaneWatermarkedLogStore<T>
            + 'static,
    {
        // TODO: parallelize these calls again
        let mut syncs = vec![];
        for domain in domains {
            let store = stores.get(domain).unwrap().clone();
            let sync = self
                .contract_sync(
                    domain,
                    metrics,
                    sync_metrics,
                    store,
                    advanced_log_meta,
                    broadcast_sender_enabled,
                )
                .await?;
            syncs.push(sync);
        }

        syncs
            .into_iter()
            .map(|i| Ok((i.domain().clone(), i)))
            .collect()
    }

    /// Build single contract sync.
    /// All contracts have to implement both sequenced and
    /// watermark trait bounds
    pub async fn contract_sync<T, S>(
        &self,
        domain: &HyperlaneDomain,
        metrics: &CoreMetrics,
        sync_metrics: &ContractSyncMetrics,
        store: Arc<S>,
        advanced_log_meta: bool,
        broadcast_sender_enabled: bool,
    ) -> Result<Arc<dyn ContractSyncer<T>>>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
        SequenceIndexer<T>: TryFromWithMetrics<ChainConf>,
        S: HyperlaneLogStore<T>
            + HyperlaneSequenceAwareIndexerStoreReader<T>
            + HyperlaneWatermarkedLogStore<T>
            + 'static,
    {
        let sync = match T::indexing_cursor(domain.domain_protocol()) {
            CursorType::SequenceAware => self
                .sequenced_contract_sync(
                    domain,
                    metrics,
                    sync_metrics,
                    store,
                    advanced_log_meta,
                    broadcast_sender_enabled,
                )
                .await
                .map(|r| r as Arc<dyn ContractSyncer<T>>)?,
            CursorType::RateLimited => self
                .watermark_contract_sync(
                    domain,
                    metrics,
                    sync_metrics,
                    store,
                    advanced_log_meta,
                    broadcast_sender_enabled,
                )
                .await
                .map(|r| r as Arc<dyn ContractSyncer<T>>)?,
        };
        Ok(sync)
    }
}

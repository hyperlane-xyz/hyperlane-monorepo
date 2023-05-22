use std::collections::HashSet;
use std::fmt::Debug;
use std::{collections::HashMap, sync::Arc};

use eyre::{eyre, Context, Result};
use futures_util::future::try_join_all;
use serde::Deserialize;

use hyperlane_core::{
    config::*, Delivery, HyperlaneChain, HyperlaneDomain, HyperlaneMessageStore, HyperlaneProvider,
    HyperlaneWatermarkedLogStore, InterchainGasPaymaster, InterchainGasPayment, Mailbox,
    MultisigIsm, ValidatorAnnounce, H256,
};

use crate::{
    settings::{
        chains::{ChainConf, RawChainConf},
        signers::SignerConf,
        trace::TracingConfig,
    },
    CoreMetrics, HyperlaneAgentCore, RawSignerConf,
};
use crate::{ContractSync, ContractSyncMetrics, MessageContractSync, WatermarkContractSync};

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
#[derive(Debug, Default)]
pub struct Settings {
    /// Configuration for contracts on each chain
    pub chains: HashMap<String, ChainConf>,
    /// Port to listen for prometheus scrape requests
    pub metrics_port: u16,
    /// The tracing configuration
    pub tracing: TracingConfig,
}

/// Raw base settings.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSettings {
    chains: Option<HashMap<String, RawChainConf>>,
    defaultsigner: Option<RawSignerConf>,
    metrics: Option<StrOrInt>,
    tracing: Option<TracingConfig>,
}

impl FromRawConf<'_, RawSettings, Option<&HashSet<&str>>> for Settings {
    fn from_config_filtered(
        raw: RawSettings,
        cwp: &ConfigPath,
        filter: Option<&HashSet<&str>>,
    ) -> Result<Self, ConfigParsingError> {
        let mut err = ConfigParsingError::default();
        let chains: HashMap<String, ChainConf> = if let Some(mut chains) = raw.chains {
            let default_signer: Option<SignerConf> = raw.defaultsigner.and_then(|r| {
                r.parse_config(&cwp.join("defaultsigner"))
                    .take_config_err(&mut err)
            });
            if let Some(filter) = filter {
                chains.retain(|k, _| filter.contains(&k.as_str()));
            }
            let chains_path = cwp.join("chains");
            chains
                .into_iter()
                .map(|(k, v)| {
                    let mut parsed: ChainConf = v.parse_config(&chains_path.join(&k))?;
                    if let Some(default_signer) = &default_signer {
                        parsed.signer.get_or_insert_with(|| default_signer.clone());
                    }
                    Ok((k, parsed))
                })
                .filter_map(|res| match res {
                    Ok((k, v)) => Some((k, v)),
                    Err(e) => {
                        err.merge(e);
                        None
                    }
                })
                .collect()
        } else {
            Default::default()
        };
        let tracing = raw.tracing.unwrap_or_default();
        let metrics = raw
            .metrics
            .and_then(|port| port.try_into().take_err(&mut err, || cwp + "metrics"))
            .unwrap_or(9090);

        err.into_result()?;
        Ok(Self {
            chains,
            metrics_port: metrics,
            tracing,
        })
    }
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
    pub fn chain_setup(&self, domain: &HyperlaneDomain) -> eyre::Result<&ChainConf> {
        self.chains
            .get(domain.name())
            .ok_or_else(|| eyre!("No chain setup found for {domain}"))
    }

    /// Try to get the domain for a given chain by name.
    pub fn lookup_domain(&self, chain_name: &str) -> eyre::Result<HyperlaneDomain> {
        self.chains
            .get(chain_name)
            .ok_or_else(|| eyre!("No chain setup found for {chain_name}"))
            .map(|c| c.domain.clone())
    }

    /// Create the core metrics from the settings given the name of the agent.
    pub fn metrics(&self, name: &str) -> eyre::Result<Arc<CoreMetrics>> {
        Ok(Arc::new(CoreMetrics::new(
            name,
            self.metrics_port,
            prometheus::Registry::new(),
        )?))
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
macro_rules! build_contract_fns {
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
        ) -> Result<HashMap<HyperlaneDomain, Arc<$ret>>> {
            try_join_all(domains.map(|d| self.$singular(d, metrics)))
                .await?
                .into_iter()
                .map(|i| Ok((i.domain().clone(), Arc::from(i))))
                .collect()
        }
    };
}

/// Generate a call to ChainSetup for the given builder
macro_rules! build_indexer_fns {
    ($singular:ident, $plural:ident -> $db:ty, $ret:ty) => {
        /// Delegates building to ChainSetup
        pub async fn $singular(
            &self,
            domain: &HyperlaneDomain,
            metrics: &CoreMetrics,
            sync_metrics: &ContractSyncMetrics,
            db: Arc<$db>,
        ) -> eyre::Result<Box<$ret>> {
            let setup = self.chain_setup(domain)?;
            let indexer = setup.$singular(metrics).await?;
            let sync: $ret = ContractSync::new(
                domain.clone(),
                db.clone(),
                indexer.into(),
                sync_metrics.clone(),
            );

            Ok(Box::new(sync))
        }

        /// Builds a contract for each domain
        pub async fn $plural(
            &self,
            domains: impl Iterator<Item = &HyperlaneDomain>,
            metrics: &CoreMetrics,
            sync_metrics: &ContractSyncMetrics,
            dbs: HashMap<HyperlaneDomain, Arc<$db>>,
        ) -> Result<HashMap<HyperlaneDomain, Arc<$ret>>> {
            try_join_all(
                domains
                    .map(|d| self.$singular(d, metrics, sync_metrics, dbs.get(d).unwrap().clone())),
            )
            .await?
            .into_iter()
            .map(|i| Ok((i.domain().clone(), Arc::from(i))))
            .collect()
        }
    };
}

impl Settings {
    build_contract_fns!(build_interchain_gas_paymaster, build_interchain_gas_paymasters -> dyn InterchainGasPaymaster);
    build_contract_fns!(build_mailbox, build_mailboxes -> dyn Mailbox);
    build_contract_fns!(build_validator_announce, build_validator_announces -> dyn ValidatorAnnounce);
    build_contract_fns!(build_provider, build_providers -> dyn HyperlaneProvider);
    build_indexer_fns!(build_delivery_indexer, build_delivery_indexers -> dyn HyperlaneWatermarkedLogStore<Delivery>, WatermarkContractSync<Delivery>);
    build_indexer_fns!(build_message_indexer, build_message_indexers -> dyn HyperlaneMessageStore, MessageContractSync);
    build_indexer_fns!(build_interchain_gas_payment_indexer, build_interchain_gas_payment_indexers -> dyn HyperlaneWatermarkedLogStore<InterchainGasPayment>, WatermarkContractSync<InterchainGasPayment>);
}

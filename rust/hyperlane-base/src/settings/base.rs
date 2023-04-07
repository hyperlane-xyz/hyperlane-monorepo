use std::fmt::Debug;
use std::{collections::HashMap, sync::Arc};

use eyre::{eyre, Context};
use serde::Deserialize;

use hyperlane_core::{
    config::*,
    db::{HyperlaneDB, DB},
    HyperlaneChain, HyperlaneDomain, HyperlaneProvider, InterchainGasPaymaster,
    InterchainGasPaymasterIndexer, Mailbox, MailboxIndexer, MultisigIsm, ValidatorAnnounce, H256,
};

use crate::{
    settings::{
        chains::{ChainConf, RawChainConf},
        signers::SignerConf,
        trace::TracingConfig,
    },
    CachingInterchainGasPaymaster, CachingMailbox, CoreMetrics, HyperlaneAgentCore, RawSignerConf,
};

/// Settings. Usually this should be treated as a base config and used as
/// follows:
///
/// ```
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
    pub metrics: Option<u16>,
    /// The tracing configuration
    pub tracing: TracingConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSettings {
    chains: Option<HashMap<String, RawChainConf>>,
    defaultsigner: Option<RawSignerConf>,
    metrics: Option<StrOrInt>,
    tracing: Option<TracingConfig>,
}

impl FromRawConf<'_, RawSettings> for Settings {
    fn from_config(raw: RawSettings, cwp: &ConfigPath) -> Result<Self, ConfigParsingError> {
        let mut err = ConfigParsingError::default();
        let chains: HashMap<String, ChainConf> = if let Some(mut chains) = raw.chains {
            let default_signer: Option<SignerConf> = raw.defaultsigner.and_then(|r| {
                r.parse_config(&cwp.join("defaultsigner"))
                    .take_config_err(&mut err)
            });
            chains
                .into_iter()
                .map(|(k, v)| {
                    let mut parsed: ChainConf = v.parse_config(&cwp.join(&k))?;
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
        let metrics: Option<u16> = raw
            .metrics
            .and_then(|port| port.try_into().take_err(&mut err, || cwp + "metrics"));

        if err.is_empty() {
            Ok(Self {
                chains,
                metrics,
                tracing,
            })
        } else {
            Err(err)
        }
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
    /// Try to get a map of chain name -> mailbox contract
    pub async fn build_all_mailboxes(
        &self,
        domains: &[&HyperlaneDomain],
        metrics: &CoreMetrics,
        db: DB,
    ) -> eyre::Result<HashMap<HyperlaneDomain, CachingMailbox>> {
        let mut result = HashMap::new();
        for &domain in domains {
            let mailbox = self
                .build_caching_mailbox(domain, db.clone(), metrics)
                .await?;
            result.insert(mailbox.domain().clone(), mailbox);
        }
        Ok(result)
    }

    /// Try to get a map of chain name -> interchain gas paymaster contract
    pub async fn build_all_interchain_gas_paymasters(
        &self,
        domains: &[&HyperlaneDomain],
        metrics: &CoreMetrics,
        db: DB,
    ) -> eyre::Result<HashMap<HyperlaneDomain, CachingInterchainGasPaymaster>> {
        let mut result = HashMap::new();
        for &domain in domains {
            let igp = self
                .build_caching_interchain_gas_paymaster(domain, db.clone(), metrics)
                .await?;
            result.insert(igp.paymaster().domain().clone(), igp);
        }
        Ok(result)
    }

    /// Try to get a CachingMailbox
    async fn build_caching_mailbox(
        &self,
        domain: &HyperlaneDomain,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingMailbox> {
        let mailbox = self
            .build_mailbox(domain, metrics)
            .await
            .with_context(|| format!("Building mailbox for {domain}"))?;
        let indexer = self
            .build_mailbox_indexer(domain, metrics)
            .await
            .with_context(|| format!("Building mailbox indexer for {domain}"))?;
        let hyperlane_db = HyperlaneDB::new(domain.name(), db);
        Ok(CachingMailbox::new(
            mailbox.into(),
            hyperlane_db,
            indexer.into(),
        ))
    }

    /// Try to get a CachingInterchainGasPaymaster
    async fn build_caching_interchain_gas_paymaster(
        &self,
        domain: &HyperlaneDomain,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingInterchainGasPaymaster> {
        let interchain_gas_paymaster = self.build_interchain_gas_paymaster(domain, metrics).await?;
        let indexer = self
            .build_interchain_gas_paymaster_indexer(domain, metrics)
            .await?;
        let hyperlane_db = HyperlaneDB::new(domain.name(), db);
        Ok(CachingInterchainGasPaymaster::new(
            interchain_gas_paymaster.into(),
            hyperlane_db,
            indexer.into(),
        ))
    }

    /// Try to get a MultisigIsm
    pub async fn build_multisig_ism(
        &self,
        domain: &HyperlaneDomain,
        address: H256,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MultisigIsm>> {
        let setup = self
            .chain_setup(domain)
            .with_context(|| format!("Building multisig ism for {domain}"))?;
        setup.build_multisig_ism(address, metrics).await
    }

    /// Try to get a ValidatorAnnounce
    pub async fn build_validator_announce(
        &self,
        domain: &HyperlaneDomain,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Arc<dyn ValidatorAnnounce>> {
        let setup = self.chain_setup(domain)?;
        let announce = setup
            .build_validator_announce(metrics)
            .await
            .with_context(|| format!("Building validator announce for {domain}"))?;
        Ok(announce.into())
    }

    pub fn chain_setup(&self, domain: &HyperlaneDomain) -> eyre::Result<&ChainConf> {
        self.chain_setup_by_name(domain.name())
    }

    /// Try to get the chain setup for the provided chain name
    pub fn chain_setup_by_name(&self, chain_name: &str) -> eyre::Result<&ChainConf> {
        self.chains
            .get(chain_name)
            .ok_or_else(|| eyre!("No chain setup found for {chain_name}"))
    }

    pub fn lookup_domain(&self, chain_name: &str) -> eyre::Result<HyperlaneDomain> {
        self.chain_setup_by_name(chain_name)
            .map(|c| c.domain.clone())
    }

    /// Create the core metrics from the settings given the name of the agent.
    pub fn metrics(&self, name: &str) -> eyre::Result<Arc<CoreMetrics>> {
        Ok(Arc::new(CoreMetrics::new(
            name,
            self.metrics,
            prometheus::Registry::new(),
        )?))
    }

    /// Private to preserve linearity of AgentCore::from_settings -- creating an
    /// agent consumes the settings.
    fn clone(&self) -> Self {
        Self {
            chains: self.chains.clone(),
            metrics: self.metrics.clone(),
            tracing: self.tracing.clone(),
        }
    }
}

/// Generate a call to ChainSetup for the given builder
macro_rules! delegate_fn {
    ($name:ident -> $ret:ty) => {
        /// Delegates building to ChainSetup
        pub async fn $name(
            &self,
            domain: &HyperlaneDomain,
            metrics: &CoreMetrics,
        ) -> eyre::Result<Box<$ret>> {
            let setup = self.chain_setup(domain)?;
            setup.$name(metrics).await
        }
    };
}

impl Settings {
    delegate_fn!(build_interchain_gas_paymaster -> dyn InterchainGasPaymaster);
    delegate_fn!(build_interchain_gas_paymaster_indexer -> dyn InterchainGasPaymasterIndexer);
    delegate_fn!(build_mailbox -> dyn Mailbox);
    delegate_fn!(build_mailbox_indexer -> dyn MailboxIndexer);
    delegate_fn!(build_provider -> dyn HyperlaneProvider);
}

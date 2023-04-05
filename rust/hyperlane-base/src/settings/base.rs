use std::fmt::{Debug, Display};
use std::{collections::HashMap, sync::Arc};

use eyre::{eyre, Context};
use futures_util::StreamExt;
use itertools::Itertools;
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
            let default_signer: Option<SignerConf> = raw
                .defaultsigner
                .map(|r| r.parse_config(&cwp.join("defaultsigner")))
                .transpose()
                .merge_config_err_then_none(&mut err)
                .flatten();
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
            .map(|port| port.try_into())
            .transpose()
            .context("Invalid metrics port")
            .merge_err_then_none(&mut err, || cwp.join("metrics"))
            .flatten();

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
        chain_names: &[&str],
        metrics: &CoreMetrics,
        db: DB,
    ) -> eyre::Result<HashMap<HyperlaneDomain, CachingMailbox>> {
        let mut result = HashMap::new();
        for &chain_name in chain_names {
            let mailbox = self
                .build_caching_mailbox(chain_name, db.clone(), metrics)
                .await?;
            result.insert(mailbox.domain().clone(), mailbox);
        }
        Ok(result)
    }

    /// Try to get a map of chain name -> interchain gas paymaster contract
    pub async fn build_all_interchain_gas_paymasters(
        &self,
        chain_names: &[&str],
        metrics: &CoreMetrics,
        db: DB,
    ) -> eyre::Result<HashMap<HyperlaneDomain, CachingInterchainGasPaymaster>> {
        let mut result = HashMap::new();
        for &chain_name in chain_names {
            let igp = self
                .build_caching_interchain_gas_paymaster(chain_name, db.clone(), metrics)
                .await?;
            result.insert(igp.paymaster().domain().clone(), igp);
        }
        Ok(result)
    }

    /// Try to get a CachingMailbox
    async fn build_caching_mailbox(
        &self,
        chain_name: &str,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingMailbox> {
        let mailbox = self
            .build_mailbox(chain_name, metrics)
            .await
            .with_context(|| format!("Building mailbox for {chain_name}"))?;
        let indexer = self
            .build_mailbox_indexer(chain_name, metrics)
            .await
            .with_context(|| format!("Building mailbox indexer for {chain_name}"))?;
        let hyperlane_db = HyperlaneDB::new(chain_name, db);
        Ok(CachingMailbox::new(
            mailbox.into(),
            hyperlane_db,
            indexer.into(),
        ))
    }

    /// Try to get a CachingInterchainGasPaymaster
    async fn build_caching_interchain_gas_paymaster(
        &self,
        chain_name: &str,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingInterchainGasPaymaster> {
        let interchain_gas_paymaster = self
            .build_interchain_gas_paymaster(chain_name, metrics)
            .await?;
        let indexer = self
            .build_interchain_gas_paymaster_indexer(chain_name, metrics)
            .await?;
        let hyperlane_db = HyperlaneDB::new(chain_name, db);
        Ok(CachingInterchainGasPaymaster::new(
            interchain_gas_paymaster.into(),
            hyperlane_db,
            indexer.into(),
        ))
    }

    /// Try to get a MultisigIsm
    pub async fn build_multisig_ism(
        &self,
        chain_name: &str,
        address: H256,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MultisigIsm>> {
        let setup = self
            .chain_setup(chain_name)
            .with_context(|| format!("Building multisig ism for {chain_name}"))?;
        setup.build_multisig_ism(address, metrics).await
    }

    /// Try to get a ValidatorAnnounce
    pub async fn build_validator_announce(
        &self,
        chain_name: &str,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Arc<dyn ValidatorAnnounce>> {
        let setup = self.chain_setup(chain_name)?;
        let announce = setup
            .build_validator_announce(metrics)
            .await
            .with_context(|| format!("Building validator announce for {chain_name}"))?;
        Ok(announce.into())
    }

    /// Try to get the chain setup for the provided chain name
    pub fn chain_setup(&self, chain_name: &str) -> eyre::Result<&ChainConf> {
        self.chains
            .get(chain_name)
            .ok_or_else(|| eyre!("No chain setup found for {chain_name}"))
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
            chain_name: &str,
            metrics: &CoreMetrics,
        ) -> eyre::Result<Box<$ret>> {
            let setup = self.chain_setup(chain_name)?;
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

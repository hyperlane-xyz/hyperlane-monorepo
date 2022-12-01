//! Settings and configuration for Hyperlane agents
//!
//! ## Introduction
//!
//! Hyperlane Agents have a shared core, which contains connection info for rpc,
//! relevant contract addresses on each chain, etc. In addition, each agent has
//! agent-specific settings. Be convention, we represent these as a base config
//! per-Outbox contract, and a "partial" config per agent. On bootup, the agent
//! loads the configuration, establishes RPC connections, and monitors each
//! configured chain.
//!
//! All agents share the [`Settings`] struct in this crate, and then define any
//! additional `Settings` in their own crate. By convention this is done in
//! `settings.rs` using the [`decl_settings!`] macro.
//!
//! ### Configuration
//!
//! Agents read settings from the config files and/or env.
//!
//! Config files are loaded from `rust/config/default` unless specified
//! otherwise, i.e.  via $RUN_ENV and $BASE_CONFIG (see the definition of
//! `decl_settings` in `rust/hyperlane-base/src/macros.rs`).
//!
//! #### N.B.: Environment variable names correspond 1:1 with cfg file's JSON object hierarchy.
//!
//! In particular, note that any environment variables whose names are prefixed
//! with:
//!
//! * `HYP_BASE`
//!
//! * `HYP_[agentname]`, where `[agentmame]` is agent-specific, e.g.
//!   `HYP_VALIDATOR` or `HYP_RELAYER`.
//!
//! will be read as an override to be applied against the hierarchical structure
//! of the configuration provided by the json config file at
//! `./config/$RUN_ENV/$BASE_CONFIG`.
//!
//! For example, if the config file `example_config.json` is:
//!
//! ```json
//! {
//!   "environment": "test",
//!   "signers": {},
//!   "inboxes": {
//!     "test2": {
//!       "domain": "13372",
//!       ...
//!     },
//!     ...
//!   },
//! }
//! ```
//!
//! and an environment variable is supplied which defines
//! `HYP_BASE_INBOXES_TEST3_DOMAIN=1`, then the `decl_settings` macro in
//! `rust/hyperlane-base/src/macros.rs` will directly override the 'domain'
//! field found in the json config to be `1`, since the fields in the
//! environment variable name describe the path traversal to arrive at this
//! field in the JSON config object.
//!
//! ### Configuration value precedence
//!
//! Configuration key/value pairs are loaded in the following order, with later
//! sources taking precedence:
//!
//! 1. The config file specified by the `RUN_ENV` and `BASE_CONFIG`
//!    env vars. `$RUN_ENV/$BASE_CONFIG`
//! 2. The config file specified by the `RUN_ENV` env var and the
//!    agent's name. `$RUN_ENV/{agent}-partial.json`.
//!    E.g. `$RUN_ENV/validator-partial.json`
//! 3. Configuration env vars with the prefix `HYP_BASE` intended
//!    to be shared by multiple agents in the same environment
//!    E.g. `export HYP_BASE_INBOXES_KOVAN_DOMAIN=3000`
//! 4. Configuration env vars with the prefix `HYP_{agent name}`
//!    intended to be used by a specific agent.
//!    E.g. `export HYP_KATHY_CHAT_TYPE="static message"`

use std::{collections::HashMap, sync::Arc};

use eyre::{eyre, Context};
use once_cell::sync::OnceCell;
use rusoto_kms::KmsClient;
use serde::Deserialize;

pub use chains::{ChainConf, ChainSetup, CoreContractAddresses};
use hyperlane_core::{
    db::{HyperlaneDB, DB},
    HyperlaneProvider, InterchainGasPaymaster, InterchainGasPaymasterIndexer, Mailbox,
    MailboxIndexer, MultisigIsm, Signers,
};
use hyperlane_ethereum::{InterchainGasPaymasterIndexerBuilder, MailboxIndexerBuilder};
pub use signers::SignerConf;

use crate::{settings::trace::TracingConfig, CachingInterchainGasPaymaster};
use crate::{CachingMailbox, CoreMetrics, HyperlaneAgentCore};

use self::chains::GelatoConf;

/// Chain configuration
pub mod chains;
pub(crate) mod loader;
/// Signer configuration
mod signers;
/// Tracing subscriber management
pub mod trace;

static KMS_CLIENT: OnceCell<KmsClient> = OnceCell::new();

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
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Configuration for contracts on each chain
    pub chains: HashMap<String, ChainSetup>,
    /// Transaction signers
    pub signers: HashMap<String, SignerConf>,
    /// Gelato config
    pub gelato: Option<GelatoConf>,
    /// Database connection string (might be a path on the fs or a remote db)
    pub db: String,
    /// Port to listen for prometheus scrape requests
    pub metrics: Option<String>,
    /// The tracing configuration
    pub tracing: TracingConfig,
}

impl Settings {
    /// Try to generate an agent core for a named agent
    pub async fn try_into_hyperlane_core(
        &self,
        metrics: Arc<CoreMetrics>,
        chain_names: Option<Vec<&str>>,
    ) -> eyre::Result<HyperlaneAgentCore> {
        let db = DB::from_path(&self.db)?;
        // If not provided, default to using every chain listed in self.chains.
        let chain_names = match chain_names {
            Some(x) => x,
            None => Vec::from_iter(self.chains.keys().map(String::as_str)),
        };

        let mailboxes = self
            .try_into_mailboxes(chain_names.as_slice(), &metrics, db.clone())
            .await?;
        let interchain_gas_paymasters = self
            .try_into_interchain_gas_paymasters(chain_names.as_slice(), &metrics, db.clone())
            .await?;
        let multisig_isms = self
            .try_into_multisig_isms(chain_names.as_slice(), &metrics)
            .await?;

        Ok(HyperlaneAgentCore {
            mailboxes,
            interchain_gas_paymasters,
            multisig_isms,
            db,
            metrics,
            settings: self.clone(),
        })
    }

    /// Try to get a signer instance by name
    pub async fn get_signer(&self, name: &str) -> Option<Signers> {
        self.signers.get(name)?.try_into_signer().await.ok()
    }

    /// Try to get a map of chain name -> mailbox contract
    pub async fn try_into_mailboxes(
        &self,
        chain_names: &[&str],
        metrics: &CoreMetrics,
        db: DB,
    ) -> eyre::Result<HashMap<String, CachingMailbox>> {
        let mut result = HashMap::new();
        for &chain_name in chain_names {
            let mailbox = self
                .try_caching_mailbox(chain_name, db.clone(), metrics)
                .await?;
            result.insert(chain_name.into(), mailbox);
        }
        Ok(result)
    }

    /// Try to get a map of chain name -> interchain gas paymaster contract
    pub async fn try_into_interchain_gas_paymasters(
        &self,
        chain_names: &[&str],
        metrics: &CoreMetrics,
        db: DB,
    ) -> eyre::Result<HashMap<String, CachingInterchainGasPaymaster>> {
        let mut result = HashMap::new();
        for &chain_name in chain_names {
            let mailbox = self
                .try_caching_interchain_gas_paymaster(chain_name, db.clone(), metrics)
                .await?;
            result.insert(chain_name.into(), mailbox);
        }
        Ok(result)
    }

    /// Try to get a map of chain name -> multisig ism contract
    pub async fn try_into_multisig_isms(
        &self,
        chain_names: &[&str],
        metrics: &CoreMetrics,
    ) -> eyre::Result<HashMap<String, Arc<dyn MultisigIsm>>> {
        let mut result: HashMap<String, Arc<dyn MultisigIsm>> = HashMap::new();
        for &chain_name in chain_names {
            let multisig_ism = self.try_multisig_ism(chain_name, metrics).await?;
            result.insert(chain_name.into(), multisig_ism.into());
        }
        Ok(result)
    }

    /// Try to get an HyperlaneProvider
    pub async fn try_provider(
        &self,
        chain_name: &str,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn HyperlaneProvider>> {
        self.chains
            .get(chain_name)
            .ok_or_else(|| eyre!("No chain setup found for {chain_name}"))?
            .try_into_provider(metrics)
            .await
    }

    /// Try to get a Mailbox
    pub async fn try_mailbox(
        &self,
        chain_name: &str,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn Mailbox>> {
        let signer = self.get_signer(chain_name).await;
        let setup = self.try_chain_setup(chain_name)?;
        setup.try_into_mailbox(signer, metrics).await
    }

    /// Try to get a CachingMailbox
    async fn try_caching_mailbox(
        &self,
        chain_name: &str,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingMailbox> {
        let mailbox = self.try_mailbox(chain_name, metrics).await?;
        let indexer = self.try_mailbox_indexer(chain_name, metrics).await?;
        let hyperlane_db = HyperlaneDB::new(chain_name, db);
        Ok(CachingMailbox::new(
            mailbox.into(),
            hyperlane_db,
            indexer.into(),
        ))
    }

    /// Try to get an IGP
    pub async fn try_interchain_gas_paymaster(
        &self,
        chain_name: &str,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InterchainGasPaymaster>> {
        let signer = self.get_signer(chain_name).await;
        let setup = self.try_chain_setup(chain_name)?;
        setup
            .try_into_interchain_gas_paymaster(signer, metrics)
            .await
    }

    /// Try to get a CachingInterchainGasPaymaster
    async fn try_caching_interchain_gas_paymaster(
        &self,
        chain_name: &str,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingInterchainGasPaymaster> {
        let interchain_gas_paymaster = self
            .try_interchain_gas_paymaster(chain_name, metrics)
            .await?;
        let indexer = self
            .try_interchain_gas_paymaster_indexer(chain_name, metrics)
            .await?;
        let hyperlane_db = HyperlaneDB::new(chain_name, db);
        Ok(CachingInterchainGasPaymaster::new(
            interchain_gas_paymaster.into(),
            hyperlane_db,
            indexer.into(),
        ))
    }

    /// Try to get a Multisig ISM
    pub async fn try_multisig_ism(
        &self,
        chain_name: &str,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MultisigIsm>> {
        let signer = self.get_signer(chain_name).await;
        let chain_setup = self.try_chain_setup(chain_name)?;
        chain_setup.try_into_multisig_ism(signer, metrics).await
    }

    /// Try to get an indexer object for a given mailbox
    pub async fn try_mailbox_indexer(
        &self,
        chain_name: &str,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MailboxIndexer>> {
        let chain_setup = self.try_chain_setup(chain_name)?;
        let signer = self.get_signer(&chain_setup.name).await;
        let metrics_conf = chain_setup.metrics_conf(metrics.agent_name(), &signer);
        chain_setup
            .build(
                &chain_setup.addresses.mailbox,
                signer,
                metrics,
                metrics_conf,
                MailboxIndexerBuilder {
                    finality_blocks: chain_setup.finality_blocks(),
                },
            )
            .await
            .context("Building mailbox indexer")
    }

    /// Try to get an indexer object for a given interchain gas paymaster
    async fn try_interchain_gas_paymaster_indexer(
        &self,
        chain_name: &str,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InterchainGasPaymasterIndexer>> {
        let chain_setup = self.try_chain_setup(chain_name)?;
        let signer = self.get_signer(&chain_setup.name).await;
        let metrics_conf = chain_setup.metrics_conf(metrics.agent_name(), &signer);
        chain_setup
            .build(
                &chain_setup.addresses.interchain_gas_paymaster,
                signer,
                metrics,
                metrics_conf,
                InterchainGasPaymasterIndexerBuilder {
                    mailbox_address: chain_setup.addresses.mailbox.parse()?,
                    finality_blocks: chain_setup.finality_blocks(),
                },
            )
            .await
            .context("Building mailbox indexer")
    }

    /// Try to get the chain setup for the provided chain name
    pub fn try_chain_setup(&self, chain_name: &str) -> eyre::Result<&ChainSetup> {
        self.chains
            .get(chain_name)
            .ok_or_else(|| eyre!("No chain setup found for {chain_name}"))
    }

    /// Create the core metrics from the settings given the name of the agent.
    pub fn try_into_metrics(&self, name: &str) -> eyre::Result<Arc<CoreMetrics>> {
        Ok(Arc::new(CoreMetrics::new(
            name,
            self.metrics
                .as_ref()
                .map(|v| v.parse::<u16>().context("Port must be a valid u16"))
                .transpose()?,
            prometheus::Registry::new(),
        )?))
    }

    /// Private to preserve linearity of AgentCore::from_settings -- creating an
    /// agent consumes the settings.
    fn clone(&self) -> Self {
        Self {
            chains: self.chains.clone(),
            signers: self.signers.clone(),
            gelato: self.gelato.clone(),
            db: self.db.clone(),
            metrics: self.metrics.clone(),
            tracing: self.tracing.clone(),
        }
    }
}

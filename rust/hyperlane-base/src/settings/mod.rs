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
//! `rust/hyperlane-base/src/macros.rs` will directly override the 'domain' field
//! found in the json config to be `1`, since the fields in the environment
//! variable name describe the path traversal to arrive at this field in the
//! JSON config object.
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

use std::{collections::HashMap, env, sync::Arc};

use config::{Config, ConfigError, Environment, File};
use ethers::prelude::AwsSigner;
use eyre::{bail, eyre, Context, Report};
use once_cell::sync::OnceCell;
use rusoto_core::{credential::EnvironmentProvider, HttpClient};
use rusoto_kms::KmsClient;
use serde::Deserialize;
use tracing::instrument;

pub use chains::{ChainConf, ChainSetup, CoreContractAddresses};
use hyperlane_core::{
    db::{HyperlaneDB, DB},
    utils::HexString,
    HyperlaneProvider, InterchainGasPaymaster, InterchainGasPaymasterIndexer, Mailbox,
    MailboxIndexer, MultisigIsm, Signers,
};
use hyperlane_ethereum::{InterchainGasPaymasterIndexerBuilder, MailboxIndexerBuilder};

use crate::{settings::trace::TracingConfig, CachingInterchainGasPaymaster};
use crate::{CachingMailbox, CoreMetrics, HyperlaneAgentCore};

use self::chains::GelatoConf;

/// Chain configuration
pub mod chains;

/// Tracing subscriber management
pub mod trace;

static KMS_CLIENT: OnceCell<KmsClient> = OnceCell::new();

/// Load a settings object from the config locations.
///
/// Read settings from the config files and/or env
/// The config will be located at `config/default` unless specified
/// otherwise
///
/// Configs are loaded in the following precedence order:
///
/// 1. The file specified by the `RUN_ENV` and `BASE_CONFIG`
///    env vars. `RUN_ENV/BASE_CONFIG`
/// 2. The file specified by the `RUN_ENV` env var and the
///    agent's name. `RUN_ENV/<agent_prefix>-partial.json`
/// 3. Configuration env vars with the prefix `HYP_BASE` intended
///    to be shared by multiple agents in the same environment
/// 4. Configuration env vars with the prefix `HYP_<agent_prefix>`
///    intended to be used by a specific agent.
///
/// Specify a configuration directory with the `RUN_ENV` env
/// variable. Specify a configuration file with the `BASE_CONFIG`
/// env variable.
pub fn load_settings_object<'de, T: Deserialize<'de>, S: AsRef<str>>(
    agent_prefix: &str,
    config_file_name: Option<&str>,
    ignore_prefixes: &[S],
) -> eyre::Result<T> {
    let env = env::var("RUN_ENV").unwrap_or_else(|_| "default".into());

    // Derive additional prefix from agent name
    let prefix = format!("HYP_{}", agent_prefix).to_ascii_uppercase();

    let filtered_env: HashMap<String, String> = env::vars()
        .filter(|(k, _v)| {
            !ignore_prefixes
                .iter()
                .any(|prefix| k.starts_with(prefix.as_ref()))
        })
        .collect();

    let builder = Config::builder();
    let builder = if let Some(fname) = config_file_name {
        builder.add_source(File::with_name(&format!("./config/{}/{}", env, fname)))
    } else {
        builder
    };
    let config_deserializer = builder
        .add_source(
            File::with_name(&format!(
                "./config/{}/{}-partial",
                env,
                agent_prefix.to_lowercase()
            ))
            .required(false),
        )
        // Use a base configuration env variable prefix
        .add_source(
            Environment::with_prefix("HYP_BASE")
                .separator("_")
                .source(Some(filtered_env.clone())),
        )
        .add_source(
            Environment::with_prefix(&prefix)
                .separator("_")
                .source(Some(filtered_env)),
        )
        .build()?;

    Ok(serde_path_to_error::deserialize(config_deserializer)?)
}

/// Ethereum signer types
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SignerConf {
    /// A local hex key
    HexKey {
        /// Hex string of private key, without 0x prefix
        key: HexString<64>,
    },
    /// An AWS signer. Note that AWS credentials must be inserted into the env
    /// separately.
    Aws {
        /// The UUID identifying the AWS KMS Key
        id: String, // change to no _ so we can set by env
        /// The AWS region
        region: String,
    },
    #[serde(other)]
    /// Assume node will sign on RPC calls
    Node,
}

impl Default for SignerConf {
    fn default() -> Self {
        Self::Node
    }
}

impl SignerConf {
    /// Try to convert the ethereum signer to a local wallet
    #[instrument(err)]
    pub async fn try_into_signer(&self) -> Result<Signers, Report> {
        match self {
            SignerConf::HexKey { key } => Ok(Signers::Local(key.as_ref().parse()?)),
            SignerConf::Aws { id, region } => {
                let client = KMS_CLIENT.get_or_init(|| {
                    KmsClient::new_with_client(
                        rusoto_core::Client::new_with(
                            EnvironmentProvider::default(),
                            HttpClient::new().unwrap(),
                        ),
                        region.parse().expect("invalid region"),
                    )
                });

                let signer = AwsSigner::new(client, id, 0).await?;
                Ok(Signers::Aws(signer))
            }
            SignerConf::Node => bail!("Node signer"),
        }
    }
}

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
pub struct DomainSettings {
    /// Configuration for contracts on each chain
    pub chains: HashMap<String, ChainSetup>,
    /// Transaction signers
    pub signers: HashMap<String, SignerConf>,
    /// Gelato config
    pub gelato: Option<GelatoConf>,
}

impl DomainSettings {
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
}

/// Settings specific to the application.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// The path to use for the DB file
    pub db: String,
    /// Port to listen for prometheus scrape requests
    pub metrics: Option<String>,
    /// The tracing configuration
    pub tracing: TracingConfig,
}

impl AgentSettings {
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
}

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
    /// Settings specific to a given chain
    #[serde(flatten)]
    pub chain: DomainSettings,
    /// Settings for the application as a whole
    #[serde(flatten)]
    pub app: AgentSettings,
}

impl Settings {
    /// Private to preserve linearity of AgentCore::from_settings -- creating an
    /// agent consumes the settings.
    fn clone(&self) -> Self {
        Self {
            chain: DomainSettings {
                chains: self.chain.chains.clone(),
                signers: self.chain.signers.clone(),
                gelato: self.chain.gelato.clone(),
            },
            app: AgentSettings {
                db: self.app.db.clone(),
                metrics: self.app.metrics.clone(),
                tracing: self.app.tracing.clone(),
            },
        }
    }
}

impl AsRef<AgentSettings> for Settings {
    fn as_ref(&self) -> &AgentSettings {
        &self.app
    }
}

impl AsRef<DomainSettings> for Settings {
    fn as_ref(&self) -> &DomainSettings {
        &self.chain
    }
}

impl Settings {
    /// Try to generate an agent core for a named agent
    pub async fn try_into_hyperlane_core(
        &self,
        metrics: Arc<CoreMetrics>,
        chain_names: Option<Vec<&str>>,
    ) -> eyre::Result<HyperlaneAgentCore> {
        let db = DB::from_path(&self.app.db)?;
        // If not provided, default to using every chain listed in self.chains.
        let chain_names = match chain_names {
            Some(x) => x,
            None => Vec::from_iter(self.chain.chains.keys().map(String::as_str)),
        };

        let mailboxes = self
            .chain
            .try_into_mailboxes(chain_names.as_slice(), &metrics, db.clone())
            .await?;
        let interchain_gas_paymasters = self
            .chain
            .try_into_interchain_gas_paymasters(chain_names.as_slice(), &metrics, db.clone())
            .await?;
        let multisig_isms = self
            .chain
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

    /// Read settings from the config file
    pub fn new() -> Result<Self, ConfigError> {
        let env_path = format!(
            "config/{}",
            env::var("RUN_MODE").as_deref().unwrap_or("development")
        );
        Config::builder()
            .add_source(File::with_name("config/default"))
            .add_source(File::with_name(&env_path))
            // Add in settings from the environment (with a prefix of HYPERLANE)
            // Eg.. `HYPERLANE_DEBUG=1 would set the `debug` key
            .add_source(Environment::with_prefix("HYPERLANE"))
            .build()?
            .try_deserialize()
    }
}

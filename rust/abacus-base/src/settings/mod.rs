//! Settings and configuration for Abacus agents
//!
//! ## Introduction
//!
//! Abacus Agents have a shared core, which contains connection info for rpc,
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
//! Config files are loaded from `rust/config/default` unless specified otherwise,
//! i.e.  via $RUN_ENV and $BASE_CONFIG (see the definition of `decl_settings` in
//! `rust/abacus-base/src/macros.rs`).
//!
//! #### N.B.: Environment variable names correspond 1:1 with cfg file's JSON object hierarchy.
//!
//! In particular, note that any environment variables whose names are prefixed with:
//!
//! *  `ABC_BASE`
//!
//! *  `ABC_[agentname]`, where `[agentmame]` is agent-specific, e.g. `ABC_VALIDATOR` or
//!    `ABC_RELAYER`.
//!
//! will be read as an override to be applied against the hierarchical structure of
//! the configuration provided by the json config file at
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
//! and an environment variable is supplied which defines `ABC_BASE_INBOXES_TEST3_DOMAIN=1`, then
//! the `decl_settings` macro in `rust/abacus-base/src/macros.rs` will directly override the
//! 'domain' field found in the json config to be `1`, since the fields in the environment variable
//! name describe the path traversal to arrive at this field in the JSON config object.
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
//! 3. Configuration env vars with the prefix `ABC_BASE` intended
//!    to be shared by multiple agents in the same environment
//!    E.g. `export ABC_BASE_INBOXES_KOVAN_DOMAIN=3000`
//! 4. Configuration env vars with the prefix `ABC_{agent name}`
//!    intended to be used by a specific agent.
//!    E.g. `export ABC_KATHY_CHAT_TYPE="static message"`

use std::{collections::HashMap, env, sync::Arc};

use config::{Config, ConfigError, Environment, File};
use ethers::prelude::AwsSigner;
use eyre::{bail, Report};
use once_cell::sync::OnceCell;
use rusoto_core::{credential::EnvironmentProvider, HttpClient};
use rusoto_kms::KmsClient;
use serde::Deserialize;
use tracing::instrument;

use abacus_core::{
    db::{AbacusDB, DB},
    utils::HexString,
    AbacusContract, ContractLocator, Signers,
};
use abacus_ethereum::{
    InterchainGasPaymasterIndexerBuilder, MakeableWithProvider, OutboxIndexerBuilder,
};
pub use chains::{ChainConf, ChainSetup, InboxAddresses, OutboxAddresses};

use crate::{settings::trace::TracingConfig, CachingInterchainGasPaymaster};
use crate::{
    AbacusAgentCore, CachingInbox, CachingOutbox, CoreMetrics, InboxContracts,
    InboxValidatorManagers, InterchainGasPaymasterIndexers, OutboxIndexers,
};

/// Chain configuration
pub mod chains;

/// Tracing subscriber management
pub mod trace;

static KMS_CLIENT: OnceCell<KmsClient> = OnceCell::new();

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

/// Outbox indexing settings
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexSettings {
    /// The height at which to start indexing the Outbox contract
    pub from: Option<String>,
    /// The number of blocks to query at once at which to start indexing the Outbox contract
    pub chunk: Option<String>,
}

impl IndexSettings {
    /// Get the `from` setting
    pub fn from(&self) -> u32 {
        self.from
            .as_ref()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or_default()
    }

    /// Get the `chunk_size` setting
    pub fn chunk_size(&self) -> u32 {
        self.chunk
            .as_ref()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(1999)
    }
}

/// Settings. Usually this should be treated as a base config and used as
/// follows:
///
/// ```
/// use abacus_base::*;
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
    /// The path to use for the DB file
    pub db: String,
    /// Port to listen for prometheus scrape requests
    pub metrics: Option<String>,
    /// Settings for the outbox indexer
    #[serde(default)]
    pub index: IndexSettings,
    /// Configurations for contracts on the outbox chain
    pub outbox: ChainSetup<OutboxAddresses>,
    /// Configurations for contracts on inbox chains
    pub inboxes: HashMap<String, ChainSetup<InboxAddresses>>,
    /// The tracing configuration
    pub tracing: TracingConfig,
    /// Transaction signers
    pub signers: HashMap<String, SignerConf>,
}

impl Settings {
    /// Private to preserve linearity of AgentCore::from_settings -- creating an agent consumes the settings.
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            metrics: self.metrics.clone(),
            index: self.index.clone(),
            outbox: self.outbox.clone(),
            inboxes: self.inboxes.clone(),
            tracing: self.tracing.clone(),
            signers: self.signers.clone(),
        }
    }
}

impl Settings {
    /// Try to get a signer instance by name
    pub async fn get_signer(&self, name: &str) -> Option<Signers> {
        self.signers.get(name)?.try_into_signer().await.ok()
    }

    /// Try to get a map of inbox name -> inbox contracts
    pub async fn try_inbox_contracts(
        &self,
        db: DB,
        metrics: &CoreMetrics,
    ) -> Result<HashMap<String, InboxContracts>, Report> {
        let mut result = HashMap::new();
        for (k, v) in self.inboxes.iter().filter(|(_, v)| {
            !v.disabled
                .as_ref()
                .and_then(|d| d.parse::<bool>().ok())
                .unwrap_or_default()
        }) {
            if k != &v.name {
                bail!(
                    "Inbox key does not match inbox name:\n key: {}  name: {}",
                    k,
                    v.name
                );
            }
            let caching_inbox = self.try_caching_inbox(v, db.clone(), metrics).await?;
            let validator_manager = self.try_inbox_validator_manager(v, metrics).await?;
            result.insert(
                v.name.clone(),
                InboxContracts {
                    inbox: Arc::new(caching_inbox),
                    validator_manager: Arc::new(validator_manager),
                },
            );
        }
        Ok(result)
    }

    /// Try to get a CachingInbox
    async fn try_caching_inbox(
        &self,
        chain_setup: &ChainSetup<InboxAddresses>,
        db: DB,
        metrics: &CoreMetrics,
    ) -> Result<CachingInbox, Report> {
        let signer = self.get_signer(&chain_setup.name).await;
        let inbox = chain_setup.try_into_inbox(signer, metrics).await?;
        let abacus_db = AbacusDB::new(inbox.chain_name(), db);
        Ok(CachingInbox::new(inbox, abacus_db))
    }

    /// Try to get an InboxValidatorManager
    async fn try_inbox_validator_manager(
        &self,
        chain_setup: &ChainSetup<InboxAddresses>,
        metrics: &CoreMetrics,
    ) -> Result<InboxValidatorManagers, Report> {
        let signer = self.get_signer(&chain_setup.name).await;

        chain_setup
            .try_into_inbox_validator_manager(signer, metrics)
            .await
    }

    /// Try to get a CachingOutbox
    pub async fn try_caching_outbox(
        &self,
        db: DB,
        metrics: &CoreMetrics,
    ) -> Result<CachingOutbox, Report> {
        let signer = self.get_signer(&self.outbox.name).await;
        let outbox = self.outbox.try_into_outbox(signer, metrics).await?;
        let indexer = Arc::new(self.try_outbox_indexer(metrics).await?);
        let abacus_db = AbacusDB::new(outbox.chain_name(), db);
        Ok(CachingOutbox::new(outbox, abacus_db, indexer))
    }

    /// Try to get a CachingInterchainGasPaymaster
    pub async fn try_caching_interchain_gas_paymaster(
        &self,
        db: DB,
        metrics: &CoreMetrics,
    ) -> Result<Option<CachingInterchainGasPaymaster>, Report> {
        let signer = self.get_signer(&self.outbox.name).await;
        match self
            .outbox
            .try_into_interchain_gas_paymaster(signer, metrics)
            .await?
        {
            Some(paymaster) => {
                let indexer = Arc::new(self.try_interchain_gas_paymaster_indexer(metrics).await?);
                let abacus_db = AbacusDB::new(paymaster.chain_name(), db);
                Ok(Some(CachingInterchainGasPaymaster::new(
                    paymaster, abacus_db, indexer,
                )))
            }
            None => Ok(None),
        }
    }

    /// Try to get an indexer object for a outbox
    pub async fn try_outbox_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<OutboxIndexers, Report> {
        let signer = self.get_signer(&self.outbox.name).await;
        let metrics = Some((metrics.provider_metrics(), self.outbox.metrics_conf()));
        match &self.outbox.chain {
            ChainConf::Ethereum(conn) => Ok(OutboxIndexers::Ethereum(
                OutboxIndexerBuilder {
                    from_height: self.index.from(),
                    chunk_size: self.index.chunk_size(),
                    finality_blocks: self.outbox.finality_blocks(),
                }
                .make_with_connection(
                    conn.clone(),
                    &ContractLocator {
                        chain_name: self.outbox.name.clone(),
                        domain: self.outbox.domain.parse().expect("invalid uint"),
                        address: self
                            .outbox
                            .addresses
                            .outbox
                            .parse::<ethers::types::Address>()?
                            .into(),
                    },
                    signer,
                    metrics,
                )
                .await?,
            )),
        }
    }

    /// Try to get an indexer object for an interchain gas paymaster.
    /// This function is only expected to be called when it's already been
    /// confirmed that the interchain gas paymaster address was provided in
    /// settings.
    pub async fn try_interchain_gas_paymaster_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<InterchainGasPaymasterIndexers, Report> {
        let signer = self.get_signer(&self.outbox.name).await;
        let metrics = Some((metrics.provider_metrics(), self.outbox.metrics_conf()));

        match &self.outbox.chain {
            ChainConf::Ethereum(conn) => Ok(InterchainGasPaymasterIndexers::Ethereum(
                InterchainGasPaymasterIndexerBuilder {
                    outbox_address: self
                        .outbox
                        .addresses
                        .outbox
                        .parse::<ethers::types::Address>()?,
                    from_height: self.index.from(),
                    chunk_size: self.index.chunk_size(),
                    finality_blocks: self.outbox.finality_blocks(),
                }
                .make_with_connection(
                    conn.clone(),
                    &ContractLocator {
                        chain_name: self.outbox.name.clone(),
                        domain: self.outbox.domain.parse().expect("invalid uint"),
                        address: self
                            .outbox
                            .addresses
                            .interchain_gas_paymaster
                            .as_ref()
                            .expect("interchain_gas_paymaster not provided")
                            .parse::<ethers::types::Address>()?
                            .into(),
                    },
                    signer,
                    metrics,
                )
                .await?,
            )),
        }
    }

    /// Try to generate an agent core for a named agent
    pub async fn try_into_abacus_core(
        &self,
        name: &str,
        parse_inboxes: bool,
    ) -> Result<AbacusAgentCore, Report> {
        let metrics = Arc::new(CoreMetrics::new(
            name,
            self.metrics
                .as_ref()
                .map(|v| v.parse::<u16>().expect("metrics port must be u16")),
            prometheus::Registry::new(),
        )?);

        let db = DB::from_path(&self.db)?;
        let outbox = Arc::new(self.try_caching_outbox(db.clone(), &metrics).await?);
        let interchain_gas_paymaster = self
            .try_caching_interchain_gas_paymaster(db.clone(), &metrics)
            .await?
            .map(Arc::new);

        let inbox_contracts = if parse_inboxes {
            self.try_inbox_contracts(db.clone(), &metrics).await?
        } else {
            HashMap::new()
        };

        Ok(AbacusAgentCore {
            outbox,
            inboxes: inbox_contracts,
            interchain_gas_paymaster,
            db,
            metrics,
            indexer: self.index.clone(),
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
            // Add in settings from the environment (with a prefix of ABACUS)
            // Eg.. `ABACUS_DEBUG=1 would set the `debug` key
            .add_source(Environment::with_prefix("ABACUS"))
            .build()?
            .try_deserialize()
    }
}

<<<<<<< HEAD
use serde::Deserialize;

use abacus_core::{
    AbacusAbi, ContractLocator, InterchainGasPaymaster, Mailbox, MultisigModule, Signers,
};
use abacus_ethereum::{
    Connection, EthereumInterchainGasPaymasterAbi, EthereumMailboxAbi,
    InterchainGasPaymasterBuilder, MailboxBuilder, MakeableWithProvider, MultisigModuleBuilder,
=======
use ethers::signers::Signer;
use eyre::Context;
use serde::Deserialize;

use abacus_core::{
    AbacusAbi, AbacusProvider, ContractLocator, Inbox, InboxIndexer, InboxValidatorManager,
    InterchainGasPaymaster, InterchainGasPaymasterIndexer, Outbox, OutboxIndexer, Signers,
};
use abacus_ethereum::{
    AbacusProviderBuilder, Connection, EthereumInboxAbi, EthereumInterchainGasPaymasterAbi,
    EthereumOutboxAbi, InboxBuilder, InboxIndexerBuilder, InboxValidatorManagerBuilder,
    InterchainGasPaymasterBuilder, InterchainGasPaymasterIndexerBuilder, MakeableWithProvider,
    OutboxBuilder, OutboxIndexerBuilder,
};
use ethers_prometheus::middleware::{
    ChainInfo, ContractInfo, PrometheusMiddlewareConf, WalletInfo,
>>>>>>> main
};
use ethers_prometheus::middleware::{ChainInfo, ContractInfo, PrometheusMiddlewareConf};

use crate::{CoreMetrics, IndexSettings};

/// A connection to _some_ blockchain.
///
/// Specify the chain name (enum variant) in toml under the `chain` key
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "rpcStyle", content = "connection", rename_all = "camelCase")]
pub enum ChainConf {
    /// Ethereum configuration
    Ethereum(Connection),
}

impl Default for ChainConf {
    fn default() -> Self {
        Self::Ethereum(Default::default())
    }
}

/// Ways in which transactions can be submitted to a blockchain.
#[derive(Copy, Clone, Debug, Default, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TransactionSubmissionType {
    /// Use the configured signer to sign and submit transactions in the
    /// "default" manner.
    #[default]
    Signer,
    /// Submit transactions via the Gelato relay.
    Gelato,
}

/// Configuration for using the Gelato Relay to interact with some chain.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GelatoConf {
    /// The sponsor API key for submitting sponsored calls
    pub sponsorapikey: String,
}

/// Addresses for outbox chain contracts
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreContractAddresses {
    /// Address of the mailbox contract
    pub mailbox: String,
    /// Address of the MultisigModule contract
    pub multisig_module: String,
    /// Address of the InterchainGasPaymaster contract
    pub interchain_gas_paymaster: String,
}

/// Outbox indexing settings
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexSettings {
    /// The height at which to start indexing the Outbox contract
    pub from: Option<String>,
    /// The number of blocks to query at once at which to start indexing the
    /// Outbox contract
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

/// A chain setup is a domain ID, an address on that chain (where the outbox or
/// inbox is deployed) and details for connecting to the chain API.
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChainSetup {
    /// Chain name
    pub name: String,
    /// Chain domain identifier
    pub domain: String,
    /// Number of blocks until finality
    pub finality_blocks: String,
    /// Addresses of contracts on the chain
    pub addresses: CoreContractAddresses,
    /// The chain connection details
    #[serde(flatten)]
    pub chain: ChainConf,
    /// How transactions to this chain are submitted.
    #[serde(default)]
    pub txsubmission: TransactionSubmissionType,
    /// Configure chain-specific metrics information. This will automatically
    /// add all contract addresses but will not override any set explicitly.
    /// Use `metrics_conf()` to get the metrics.
    #[serde(default)]
    pub metrics_conf: PrometheusMiddlewareConf,
    /// Settings for event indexing
    #[serde(default)]
    pub index: IndexSettings,
}

impl ChainSetup {
    /// Get the number of blocks until finality
    pub fn finality_blocks(&self) -> u32 {
        self.finality_blocks
            .parse::<u32>()
            .expect("could not parse finality_blocks")
    }

impl ChainSetup {
    /// Try to convert the chain setting into a Mailbox contract
    pub async fn try_into_mailbox(
        &self,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn Mailbox>> {
        self.try_into_contract(
            signer,
            metrics,
            MailboxBuilder {},
            self.addresses.mailbox.clone(),
        )
        .await
    }

    async fn build<B: MakeableWithProvider + Sync>(
        &self,
        address: &str,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InterchainGasPaymaster>> {
        self.try_into_contract(
            signer,
            metrics,
            InterchainGasPaymasterBuilder {},
            self.addresses.interchain_gas_paymaster.clone(),
        )
        .await
    }

    /// Try to convert the chain setting into a Multisig Module contract
    pub async fn try_into_multisig_module(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MultisigModule>> {
        self.try_into_contract(
            signer,
            metrics,
            MultisigModuleBuilder {},
            self.addresses.multisig_module.clone(),
        )
        .await
    }

    /// Try to convert the chain setting into a contract
    async fn try_into_contract<T: MakeableWithProvider>(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
        builder: T,
        address: String,
    ) -> eyre::Result<T::Output> {
        match &self.chain {
            ChainConf::Ethereum(conf) => Ok(builder
                .make_with_connection(
                    conf.clone(),
                    &ContractLocator {
                        chain_name: self.name.clone(),
                        domain: self.domain.parse().expect("invalid uint"),
                        address: address.parse::<ethers::types::Address>()?.into(),
                    },
                    signer,
                    Some(|| metrics.json_rpc_client_metrics()),
                    Some((metrics.provider_metrics(), self.metrics_conf())),
                )
                .await?),
        }
    }

    /// Get a clone of the metrics conf with correctly configured contract
    /// information.
    pub fn metrics_conf(&self) -> PrometheusMiddlewareConf {
        let mut cfg = self.metrics_conf.clone();

        if cfg.chain.is_none() {
            cfg.chain = Some(ChainInfo {
                name: Some(self.name.clone()),
            });
        }

        if let Ok(addr) = self.addresses.mailbox.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("mailbox".into()),
                functions: EthereumMailboxAbi::fn_map_owned(),
            });
        }
        if let Ok(addr) = self.addresses.interchain_gas_paymaster.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("igp".into()),
                functions: EthereumInterchainGasPaymasterAbi::fn_map_owned(),
            });
        }
        cfg
    }
}

use ethers::{abi::AbiEncode, signers::Signer};
use eyre::Context;
use serde::Deserialize;

use abacus_core::{
    AbacusAbi, AbacusProvider, ContractLocator, InterchainGasPaymaster, Mailbox, MultisigIsm,
    Signers,
};
use abacus_ethereum::{
    AbacusProviderBuilder, Connection, EthereumInterchainGasPaymasterAbi, EthereumMailboxAbi,
    EthereumMultisigIsmAbi, InterchainGasPaymasterBuilder, MailboxBuilder, MakeableWithProvider,
    MultisigIsmBuilder,
};
use ethers_prometheus::middleware::{
    ChainInfo, ContractInfo, PrometheusMiddlewareConf, WalletInfo,
};

use crate::CoreMetrics;

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
    /// Address of the MultisigIsm contract
    pub multisig_ism: String,
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

    /// Try to convert the chain settings into an AbacusProvider.
    pub async fn try_into_provider(
        &self,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn AbacusProvider>> {
        let builder = AbacusProviderBuilder {};
        let metrics_conf = {
            let mut cfg = self.metrics_conf.clone();

            if cfg.chain.is_none() {
                cfg.chain = Some(ChainInfo {
                    name: Some(self.name.clone()),
                });
            }

            cfg
        };

        let address = match &self.chain {
            ChainConf::Ethereum(_) => ethers::types::Address::zero().encode_hex(),
        };
        self.build(&address, None, metrics, metrics_conf, builder)
            .await
    }

    /// Try to convert the chain setting into a Mailbox contract
    pub async fn try_into_mailbox(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn Mailbox>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let address = &self.addresses.mailbox;
        let builder = MailboxBuilder {};
        self.build(address, signer, metrics, metrics_conf, builder)
            .await
            .context("Building outbox")
    }

    /// Try to convert the chain setting into an interchain gas paymaster contract
    pub async fn try_into_interchain_gas_paymaster(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InterchainGasPaymaster>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let address = &self.addresses.interchain_gas_paymaster;
        let builder = InterchainGasPaymasterBuilder {};
        self.build(address, signer, metrics, metrics_conf, builder)
            .await
            .context("Building igp")
    }

    /// Try to convert the chain setting into a Multisig Ism contract
    pub async fn try_into_multisig_ism(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MultisigIsm>> {
        let address = &self.addresses.multisig_ism;
        let builder = MultisigIsmBuilder {};
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        self.build(address, signer, metrics, metrics_conf, builder)
            .await
            .context("Building multisig ISM")
    }

    /// Get a clone of the metrics conf with correctly configured contract
    /// information.
    pub fn metrics_conf(
        &self,
        agent_name: &str,
        signer: &Option<Signers>,
    ) -> PrometheusMiddlewareConf {
        let mut cfg = self.metrics_conf.clone();

        if cfg.chain.is_none() {
            cfg.chain = Some(ChainInfo {
                name: Some(self.name.clone()),
            });
        }

        if let Some(signer) = signer {
            cfg.wallets
                .entry(signer.address())
                .or_insert_with(|| WalletInfo {
                    name: Some(agent_name.into()),
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
        if let Ok(addr) = self.addresses.multisig_ism.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("msm".into()),
                functions: EthereumMultisigIsmAbi::fn_map_owned(),
            });
        }
        cfg
    }

    /// Try to convert the chain setting into a contract
    pub async fn build<B: MakeableWithProvider + Sync>(
        &self,
        address: &str,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
        metrics_conf: PrometheusMiddlewareConf,
        builder: B,
    ) -> eyre::Result<B::Output> {
        match &self.chain {
            ChainConf::Ethereum(conf) => {
                builder
                    .make_with_connection(
                        conf.clone(),
                        &ContractLocator {
                            chain_name: self.name.clone(),
                            domain: self.domain.parse().expect("invalid uint"),
                            address: address.parse::<ethers::types::Address>()?.into(),
                        },
                        signer,
                        Some(|| metrics.json_rpc_client_metrics()),
                        Some((metrics.provider_metrics(), metrics_conf)),
                    )
                    .await
            }
        }
    }
}

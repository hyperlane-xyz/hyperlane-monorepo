use ethers::signers::Signer;
use serde::Deserialize;

use abacus_core::{
    AbacusAbi, ContractLocator, Inbox, InboxIndexer, InboxValidatorManager, InterchainGasPaymaster,
    InterchainGasPaymasterIndexer, Outbox, OutboxIndexer, Signers,
};
use abacus_ethereum::{
    Connection, EthereumInboxAbi, EthereumInterchainGasPaymasterAbi, EthereumOutboxAbi,
    InboxBuilder, InboxIndexerBuilder, InboxValidatorManagerBuilder, InterchainGasPaymasterBuilder,
    InterchainGasPaymasterIndexerBuilder, MakeableWithProvider, OutboxBuilder,
    OutboxIndexerBuilder,
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
pub struct OutboxAddresses {
    /// Address of the Outbox contract
    pub outbox: String,
    /// Address of the InterchainGasPaymaster contract
    pub interchain_gas_paymaster: Option<String>,
}

/// Addresses for inbox chain contracts
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InboxAddresses {
    /// Address of the Inbox contract
    pub inbox: String,
    /// Address of the InboxValidatorManager contract
    pub validator_manager: String,
}

/// A chain setup is a domain ID, an address on that chain (where the outbox or
/// inbox is deployed) and details for connecting to the chain API.
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChainSetup<T> {
    /// Chain name
    pub name: String,
    /// Chain domain identifier
    pub domain: String,
    /// Number of blocks until finality
    pub finality_blocks: String,
    /// Addresses of contracts on the chain
    pub addresses: T,
    /// The chain connection details
    #[serde(flatten)]
    pub chain: ChainConf,
    /// How transactions to this chain are submitted.
    #[serde(default)]
    pub txsubmission: TransactionSubmissionType,
    /// Set this key to disable the inbox. Does nothing for outboxes.
    #[serde(default)]
    pub disabled: Option<String>,
    /// Configure chain-specific metrics information. This will automatically
    /// add all contract addresses but will not override any set explicitly.
    /// Use `metrics_conf()` to get the metrics.
    #[serde(default)]
    pub metrics_conf: PrometheusMiddlewareConf,
}

impl<T> ChainSetup<T> {
    /// Get the number of blocks until finality
    pub fn finality_blocks(&self) -> u32 {
        self.finality_blocks
            .parse::<u32>()
            .expect("could not parse finality_blocks")
    }

    async fn build<B: MakeableWithProvider + Sync>(
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

impl ChainSetup<OutboxAddresses> {
    /// Try to convert the chain setting into an Outbox contract
    pub async fn try_into_outbox(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn Outbox>> {
        let address = &self.addresses.outbox;
        let builder = OutboxBuilder {};
        self.build(address, signer, metrics, self.metrics_conf(), builder)
            .await
    }

    /// Try to convert the chain settings into an Outbox contract indexer
    pub async fn try_into_outbox_indexer(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn OutboxIndexer>> {
        let address = &self.addresses.outbox;
        let builder = OutboxIndexerBuilder {
            finality_blocks: self.finality_blocks(),
        };
        self.build(address, signer, metrics, self.metrics_conf(), builder)
            .await
    }

    /// Try to convert the chain setting into an InterchainGasPaymaster contract
    pub async fn try_into_interchain_gas_paymaster(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Option<Box<dyn InterchainGasPaymaster>>> {
        if let Some(address) = &self.addresses.interchain_gas_paymaster {
            let builder = InterchainGasPaymasterBuilder {};
            self.build(address, signer, metrics, self.metrics_conf(), builder)
                .await
                .map(Some)
        } else {
            Ok(None)
        }
    }

    /// Try to convert the chain settings into a IGP contract indexer
    pub async fn try_into_interchain_gas_paymaster_indexer(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Option<Box<dyn InterchainGasPaymasterIndexer>>> {
        if let Some(address) = &self.addresses.interchain_gas_paymaster {
            let builder = InterchainGasPaymasterIndexerBuilder {
                outbox_address: self.addresses.outbox.parse::<ethers::types::Address>()?,
                from_height: 0,
                chunk_size: 0,
                finality_blocks: 0,
            };
            self.build(address, signer, metrics, self.metrics_conf(), builder)
                .await
                .map(Some)
        } else {
            Ok(None)
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

        if let Ok(addr) = self.addresses.outbox.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("outbox".into()),
                functions: EthereumOutboxAbi::fn_map_owned(),
            });
        }
        if let Some(igp) = &self.addresses.interchain_gas_paymaster {
            if let Ok(addr) = igp.parse() {
                cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                    name: Some("igp".into()),
                    functions: EthereumInterchainGasPaymasterAbi::fn_map_owned(),
                });
            }
        }
        cfg
    }
}

impl ChainSetup<InboxAddresses> {
    /// Try to convert the chain setting into an inbox contract
    pub async fn try_into_inbox(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn Inbox>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let address = &self.addresses.inbox;
        let builder = InboxBuilder {};
        self.build(address, signer, metrics, metrics_conf, builder)
            .await
    }

    /// Try to convert the chain settings into an inbox contract indexer.
    pub async fn try_into_inbox_indexer(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InboxIndexer>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let address = &self.addresses.inbox;
        let builder = InboxIndexerBuilder {
            finality_blocks: self.finality_blocks(),
        };
        self.build(address, signer, metrics, metrics_conf, builder)
            .await
    }

    /// Try to convert the chain setting into an InboxValidatorManager contract
    pub async fn try_into_inbox_validator_manager(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InboxValidatorManager>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let address = &self.addresses.validator_manager;
        let inbox_address = self.addresses.inbox.parse::<ethers::types::Address>()?;
        let builder = InboxValidatorManagerBuilder { inbox_address };
        self.build(address, signer, metrics, metrics_conf, builder)
            .await
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
        if let Ok(addr) = self.addresses.inbox.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("inbox".into()),
                functions: EthereumInboxAbi::fn_map_owned(),
            });
        }
        if let Ok(addr) = self.addresses.validator_manager.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("ivm".into()),
                functions: EthereumOutboxAbi::fn_map_owned(),
            });
        }
        cfg
    }
}

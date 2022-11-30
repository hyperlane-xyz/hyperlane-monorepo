use std::collections::HashMap;
use std::sync::{Arc, Weak};

use ethers::signers::Signer;
use lazy_static::lazy_static;
use serde::Deserialize;
use tokio::sync::Mutex;

use abacus_core::{
    AbacusAbi, AbacusProvider, ContractLocator, InterchainGasPaymaster,
    InterchainGasPaymasterIndexer, Mailbox, MailboxIndexer, MultisigIsm, Signers,
};
use abacus_ethereum::{
    create_connection, create_provider, ConnectionConfig, DynamicJsonRpcClient, DynamicMiddleware,
    EthereumInterchainGasPaymaster, EthereumInterchainGasPaymasterAbi,
    EthereumInterchainGasPaymasterIndexer, EthereumMailbox, EthereumMailboxAbi,
    EthereumMailboxIndexer, EthereumMultisigIsm, EthereumMultisigIsmAbi, EthereumProvider,
};
use ethers_prometheus::middleware::{
    ChainInfo, ContractInfo, PrometheusMiddlewareConf, WalletInfo,
};

use crate::CoreMetrics;

lazy_static! {
    static ref ETHEREUM_RPC_CLIENTS: Mutex<HashMap<ConnectionConfig, Weak<DynamicJsonRpcClient>>> =
        Default::default();
}

/// A connection to _some_ blockchain.
///
/// Specify the chain name (enum variant) in toml under the `chain` key
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "rpcStyle", content = "connection", rename_all = "camelCase")]
pub enum ChainConf {
    /// Ethereum configuration
    Ethereum(ConnectionConfig),
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

    /// Get the domain of this chain
    pub fn domain(&self) -> u32 {
        // TODO: can we use AbacusDomain instead?
        self.domain.parse::<u32>().expect("could not parse domain")
    }

    /// Try to convert the chain settings into an AbacusProvider.
    pub async fn build_provider(
        &self,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn AbacusProvider>> {
        let metrics_conf = {
            let mut cfg = self.metrics_conf.clone();

            if cfg.chain.is_none() {
                cfg.chain = Some(ChainInfo {
                    name: Some(self.name.clone()),
                });
            }

            cfg
        };

        Ok(match self.chain {
            ChainConf::Ethereum(_) => Box::new(EthereumProvider::new(
                self.ethereum_provider(None, metrics, metrics_conf).await?,
                self.name.clone(),
                self.domain(),
            )),
        })
    }

    /// Try to convert the chain setting into a Mailbox contract
    pub async fn build_mailbox(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn Mailbox>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.mailbox)?;

        Ok(match self.chain {
            ChainConf::Ethereum(_) => Box::new(EthereumMailbox::new(
                self.ethereum_provider(signer, metrics, metrics_conf)
                    .await?,
                &locator,
            )),
        })
    }

    /// Try to convert the chain settings into a mailbox indexer.
    pub async fn build_mailbox_indexer(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MailboxIndexer>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.mailbox)?;
        Ok(match self.chain {
            ChainConf::Ethereum(_) => Box::new(EthereumMailboxIndexer::new(
                self.ethereum_provider(signer, metrics, metrics_conf)
                    .await?,
                &locator,
                self.finality_blocks(),
            )),
        })
    }

    /// Try to convert the chain setting into an interchain gas paymaster
    /// contract
    pub async fn build_interchain_gas_paymaster(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InterchainGasPaymaster>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.interchain_gas_paymaster)?;
        Ok(match self.chain {
            ChainConf::Ethereum(_) => Box::new(EthereumInterchainGasPaymaster::new(
                self.ethereum_provider(signer, metrics, metrics_conf)
                    .await?,
                &locator,
            )),
        })
    }

    /// Try to convert the chain settings into an interchain gas paymaster
    /// inedexer.
    pub async fn build_interchain_gas_paymaster_indexer(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn InterchainGasPaymasterIndexer>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.interchain_gas_paymaster)?;
        Ok(match self.chain {
            ChainConf::Ethereum(_) => Box::new(EthereumInterchainGasPaymasterIndexer::new(
                self.ethereum_provider(signer, metrics, metrics_conf)
                    .await?,
                &locator,
                self.finality_blocks(),
            )),
        })
    }

    /// Try to convert the chain setting into a Multisig Ism contract
    pub async fn build_multisig_ism(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Box<dyn MultisigIsm>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.multisig_ism)?;
        Ok(match self.chain {
            ChainConf::Ethereum(_) => Box::new(EthereumMultisigIsm::new(
                self.ethereum_provider(signer, metrics, metrics_conf)
                    .await?,
                &locator,
            )),
        })
    }

    /// Get a clone of the metrics conf with correctly configured contract
    /// information.
    fn metrics_conf(&self, agent_name: &str, signer: &Option<Signers>) -> PrometheusMiddlewareConf {
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

    fn locator(&self, address: &str) -> eyre::Result<ContractLocator> {
        Ok(ContractLocator {
            chain_name: self.name.clone(),
            domain: self.domain(),
            address: address.parse::<ethers::types::Address>()?.into(),
        })
    }

    async fn ethereum_provider(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
        metrics_conf: PrometheusMiddlewareConf,
    ) -> eyre::Result<Arc<DynamicMiddleware>> {
        let ChainConf::Ethereum(conf) = &self.chain;
        // uncomment when we add another chain and the above becomes an error
        // else {
        //     unreachable!("This function should only be called for Ethereum chains")
        // };

        let client = {
            let mut clients = ETHEREUM_RPC_CLIENTS.lock().await;
            let maybe_client = clients.get(conf).and_then(|r| r.upgrade());
            if let Some(client) = maybe_client {
                client
            } else {
                let client = Arc::new(
                    create_connection(
                        conf.clone(),
                        Some(metrics.json_rpc_client_metrics()),
                        &self.name,
                    )
                    .await?,
                );
                clients.insert(conf.clone(), Arc::downgrade(&client));
                client
            }
        };

        create_provider(
            client,
            signer,
            Some((metrics.provider_metrics(), metrics_conf)),
        )
        .await
        .map(Arc::new)
    }
}

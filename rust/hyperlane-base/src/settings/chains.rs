use ethers::signers::Signer;
use eyre::Result;
use eyre::{ensure, eyre, Context};
use serde::Deserialize;

use ethers_prometheus::middleware::{
    ChainInfo, ContractInfo, PrometheusMiddlewareConf, WalletInfo,
};
use hyperlane_core::{
    ContractLocator, HyperlaneAbi, HyperlaneDomain, HyperlaneDomainImpl, HyperlaneProvider,
    InterchainGasPaymaster, InterchainGasPaymasterIndexer, Mailbox, MailboxIndexer, MultisigIsm,
    Signers,
};
use hyperlane_ethereum::{
    BuildableWithProvider, ConnectionConf, EthereumInterchainGasPaymasterAbi, EthereumMailboxAbi,
    EthereumMultisigIsmAbi,
};

use crate::CoreMetrics;

/// A connection to _some_ blockchain.
///
/// Specify the chain name (enum variant) in toml under the `chain` key
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "rpcStyle", content = "connection", rename_all = "camelCase")]
pub enum ChainConf {
    /// Ethereum configuration
    Ethereum(ConnectionConf),
    /// Fuel configuration
    Fuel,
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

/// Addresses for mailbox chain contracts
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

/// Indexing settings
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexSettings {
    /// The height at which to start indexing the Outbox contract
    pub from: Option<String>,
    /// The number of blocks to query at once at which to start indexing the
    /// Mailbox contract
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

/// A chain setup is a domain ID, an address on that chain (where the mailbox is
/// deployed) and details for connecting to the chain API.
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
    /// Try to convert the chain settings into an HyperlaneProvider.
    pub async fn build_provider(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn HyperlaneProvider>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);

        match &self.chain {
            ChainConf::Ethereum(conf) => {
                hyperlane_ethereum::HyperlaneProviderBuilder {}
                    .build_with_connection_conf(
                        conf.clone(),
                        &self.locator("0x0000000000000000000000000000000000000000")?,
                        signer,
                        Some(|| metrics.json_rpc_client_metrics()),
                        Some((metrics.provider_metrics(), metrics_conf)),
                    )
                    .await
            }

            ChainConf::Fuel => todo!(),
        }
        .context("Building provider")
    }

    /// Try to convert the chain setting into a Mailbox contract
    pub async fn build_mailbox(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn Mailbox>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.mailbox)?;
        match &self.chain {
            ChainConf::Ethereum(conf) => {
                hyperlane_ethereum::MailboxBuilder {}
                    .build_with_connection_conf(
                        conf.clone(),
                        &locator,
                        signer,
                        Some(|| metrics.json_rpc_client_metrics()),
                        Some((metrics.provider_metrics(), metrics_conf)),
                    )
                    .await
            }

            ChainConf::Fuel => todo!(),
        }
        .context("Building mailbox")
    }

    /// Try to convert the chain settings into a mailbox indexer
    pub async fn build_mailbox_indexer(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MailboxIndexer>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.mailbox)?;

        match &self.chain {
            ChainConf::Ethereum(conf) => {
                hyperlane_ethereum::MailboxIndexerBuilder {
                    finality_blocks: self.finality_blocks(),
                }
                .build_with_connection_conf(
                    conf.clone(),
                    &locator,
                    signer,
                    Some(|| metrics.json_rpc_client_metrics()),
                    Some((metrics.provider_metrics(), metrics_conf)),
                )
                .await
            }

            ChainConf::Fuel => todo!(),
        }
        .context("Building mailbox indexer")
    }

    /// Try to convert the chain setting into an interchain gas paymaster
    /// contract
    pub async fn build_interchain_gas_paymaster(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn InterchainGasPaymaster>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.interchain_gas_paymaster)?;

        match &self.chain {
            ChainConf::Ethereum(conf) => {
                hyperlane_ethereum::InterchainGasPaymasterBuilder {}
                    .build_with_connection_conf(
                        conf.clone(),
                        &locator,
                        signer,
                        Some(|| metrics.json_rpc_client_metrics()),
                        Some((metrics.provider_metrics(), metrics_conf)),
                    )
                    .await
            }

            ChainConf::Fuel => todo!(),
        }
        .context("Building IGP")
    }

    /// Try to convert the chain settings into a IGP indexer
    pub async fn build_interchain_gas_paymaster_indexer(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn InterchainGasPaymasterIndexer>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.interchain_gas_paymaster)?;

        match &self.chain {
            ChainConf::Ethereum(conf) => {
                hyperlane_ethereum::InterchainGasPaymasterIndexerBuilder {
                    mailbox_address: self.addresses.mailbox.parse()?,
                    finality_blocks: self.finality_blocks(),
                }
                .build_with_connection_conf(
                    conf.clone(),
                    &locator,
                    signer,
                    Some(|| metrics.json_rpc_client_metrics()),
                    Some((metrics.provider_metrics(), metrics_conf)),
                )
                .await
            }

            ChainConf::Fuel => todo!(),
        }
        .context("Building IGP indexer")
    }

    /// Try to convert the chain setting into a Multisig Ism contract
    pub async fn build_multisig_ism(
        &self,
        signer: Option<Signers>,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MultisigIsm>> {
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let locator = self.locator(&self.addresses.multisig_ism)?;

        match &self.chain {
            ChainConf::Ethereum(conf) => {
                hyperlane_ethereum::MultisigIsmBuilder {}
                    .build_with_connection_conf(
                        conf.clone(),
                        &locator,
                        signer,
                        Some(|| metrics.json_rpc_client_metrics()),
                        Some((metrics.provider_metrics(), metrics_conf)),
                    )
                    .await
            }

            ChainConf::Fuel => todo!(),
        }
        .context("Building multisig ISM")
    }

    /// Get the number of blocks until finality
    fn finality_blocks(&self) -> u32 {
        self.finality_blocks
            .parse::<u32>()
            .expect("could not parse finality_blocks")
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

    fn locator(&self, address: &str) -> Result<ContractLocator> {
        let domain = self.domain()?;
        let address = match self.chain {
            ChainConf::Ethereum(_) => {
                ensure!(
                    matches!(
                        domain.domain_impl(),
                        HyperlaneDomainImpl::Ethereum | HyperlaneDomainImpl::Unknown
                    ),
                    "Excepted an ethereum chain config"
                );
                address
                    .parse::<ethers::types::Address>()
                    .context("Invalid ethereum address")?
                    .into()
            }
            ChainConf::Fuel => {
                ensure!(
                    matches!(
                        domain.domain_impl(),
                        HyperlaneDomainImpl::Fuel | HyperlaneDomainImpl::Unknown
                    ),
                    "Expected a fuel chain config"
                );
                todo!()
            }
        };

        Ok(ContractLocator { domain, address })
    }

    fn domain(&self) -> Result<HyperlaneDomain> {
        HyperlaneDomain::from_config(
            self.domain
                .parse::<u32>()
                .context("domain is an invalid uint")?,
            &self.name,
        )
        .map_err(|e| eyre!("{e}"))
    }
}

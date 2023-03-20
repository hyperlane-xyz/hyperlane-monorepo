use std::collections::HashMap;

use ethers::prelude::Selector;
use eyre::{eyre, Context, Result};
use serde::Deserialize;

use ethers_prometheus::middleware::{
    ChainInfo, ContractInfo, PrometheusMiddlewareConf, WalletInfo,
};
use hyperlane_core::{
    utils::StrOrInt, ContractLocator, HyperlaneAbi, HyperlaneDomain, HyperlaneDomainProtocol,
    HyperlaneProvider, HyperlaneSigner, InterchainGasPaymaster, InterchainGasPaymasterIndexer,
    Mailbox, MailboxIndexer, MultisigIsm, ValidatorAnnounce, H256,
};
use hyperlane_ethereum::{
    self as h_eth, BuildableWithProvider, EthereumInterchainGasPaymasterAbi, EthereumMailboxAbi,
};
use hyperlane_fuel::{self as h_fuel, prelude::*};

use crate::{settings::signers::BuildableWithSignerConf, CoreMetrics, SignerConf};

/// A connection to _some_ blockchain.
///
/// Specify the chain name (enum variant) in toml under the `chain` key
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "protocol", content = "connection", rename_all = "camelCase")]
pub enum ChainConnectionConf {
    /// Ethereum configuration
    Ethereum(h_eth::ConnectionConf),
    /// Fuel configuration
    Fuel(h_fuel::ConnectionConf),
}

impl ChainConnectionConf {
    fn protocol(&self) -> HyperlaneDomainProtocol {
        match self {
            Self::Ethereum(_) => HyperlaneDomainProtocol::Ethereum,
            Self::Fuel(_) => HyperlaneDomainProtocol::Fuel,
        }
    }
}

impl Default for ChainConnectionConf {
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
}

/// Addresses for mailbox chain contracts
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreContractAddresses {
    /// Address of the mailbox contract
    pub mailbox: String,
    /// Address of the InterchainGasPaymaster contract
    pub interchain_gas_paymaster: String,
    /// Address of the ValidatorAnnounce contract
    pub validator_announce: String,
}

/// Indexing settings
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexSettings {
    /// The height at which to start indexing the Outbox contract
    pub from: Option<StrOrInt>,
    /// The number of blocks to query at once at which to start indexing the
    /// Mailbox contract
    pub chunk: Option<StrOrInt>,
}

impl IndexSettings {
    /// Get the `from` setting
    pub fn from(&self) -> u32 {
        self.from
            .as_ref()
            .and_then(|s| s.try_into().ok())
            .unwrap_or_default()
    }

    /// Get the `chunk_size` setting
    pub fn chunk_size(&self) -> u32 {
        self.chunk
            .as_ref()
            .and_then(|s| s.try_into().ok())
            .unwrap_or(1999)
    }
}

/// A chain setup is a domain ID, an address on that chain (where the mailbox is
/// deployed) and details for connecting to the chain API.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSetup {
    /// Chain name
    pub name: String,
    /// Chain domain identifier
    pub domain: StrOrInt,
    /// Signer configuration for this chain
    pub signer: Option<SignerConf>,
    /// Number of blocks until finality
    pub finality_blocks: StrOrInt,
    /// Addresses of contracts on the chain
    pub addresses: CoreContractAddresses,
    /// The chain connection details
    #[serde(flatten, default)]
    pub connection: Option<ChainConnectionConf>,
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
    /// Get the chain connection config or generate an error
    pub fn connection(&self) -> Result<&ChainConnectionConf> {
        self.connection.as_ref().ok_or_else(|| eyre!("Missing chain configuration for {}; this includes protocol and connection information", self.name))
    }

    /// Try to convert the chain settings into an HyperlaneProvider.
    pub async fn build_provider(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn HyperlaneProvider>> {
        let ctx = "Building provider";
        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                let locator = self
                    .locator("0x0000000000000000000000000000000000000000")
                    .context(ctx)?;
                self.build_ethereum(conf, &locator, metrics, h_eth::HyperlaneProviderBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a Mailbox contract
    pub async fn build_mailbox(&self, metrics: &CoreMetrics) -> Result<Box<dyn Mailbox>> {
        let ctx = "Building provider";
        let locator = self.locator(&self.addresses.mailbox).context(ctx)?;

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MailboxBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(conf) => {
                let wallet = self.fuel_signer().await.context(ctx)?;
                hyperlane_fuel::FuelMailbox::new(conf, locator, wallet)
                    .map(|m| Box::new(m) as Box<dyn Mailbox>)
                    .map_err(Into::into)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a mailbox indexer
    pub async fn build_mailbox_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MailboxIndexer>> {
        let ctx = "Building mailbox indexer";
        let locator = self.locator(&self.addresses.mailbox).context(ctx)?;

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::MailboxIndexerBuilder {
                        finality_blocks: self.finality_blocks(),
                    },
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into an interchain gas paymaster
    /// contract
    pub async fn build_interchain_gas_paymaster(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn InterchainGasPaymaster>> {
        let ctx = "Building IGP";
        let locator = self
            .locator(&self.addresses.interchain_gas_paymaster)
            .context(ctx)?;

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainGasPaymasterBuilder {},
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a IGP indexer
    pub async fn build_interchain_gas_paymaster_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn InterchainGasPaymasterIndexer>> {
        let ctx = "Building IGP indexer";
        let locator = self
            .locator(&self.addresses.interchain_gas_paymaster)
            .context(ctx)?;

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainGasPaymasterIndexerBuilder {
                        mailbox_address: self
                            .addresses
                            .mailbox
                            .parse()
                            .context("Parsing mailbox address")
                            .context(ctx)?,
                        finality_blocks: self.finality_blocks(),
                    },
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a ValidatorAnnounce
    pub async fn build_validator_announce(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn ValidatorAnnounce>> {
        let locator = self.locator(&self.addresses.validator_announce)?;
        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::ValidatorAnnounceBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context("Building ValidatorAnnounce")
    }

    /// Try to convert the chain setting into a Multisig Ism contract
    pub async fn build_multisig_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MultisigIsm>> {
        let ctx = "Building multisig ISM";
        let locator = ContractLocator {
            domain: self
                .domain()
                .context("Invalid domain for locating contract")
                .context(ctx)?,
            address,
        };

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MultisigIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Get the domain for this chain setup
    pub fn domain(&self) -> Result<HyperlaneDomain> {
        HyperlaneDomain::from_config(
            (&self.domain).try_into().context("Invalid domain id")?,
            &self.name,
            self.connection()?.protocol(),
        )
        .map_err(|e| eyre!("{e}"))
    }

    /// Get the number of blocks until finality
    fn finality_blocks(&self) -> u32 {
        (&self.finality_blocks)
            .try_into()
            .expect("could not parse finality_blocks")
    }

    async fn signer<S: BuildableWithSignerConf>(&self) -> Result<Option<S>> {
        if let Some(conf) = &self.signer {
            Ok(Some(conf.build::<S>().await?))
        } else {
            Ok(None)
        }
    }

    async fn ethereum_signer(&self) -> Result<Option<h_eth::Signers>> {
        self.signer().await
    }

    async fn fuel_signer(&self) -> Result<fuels::prelude::WalletUnlocked> {
        self.signer().await.and_then(|opt| {
            opt.ok_or_else(|| eyre!("Fuel requires a signer to construct contract instances"))
        })
    }

    /// Get a clone of the ethereum metrics conf with correctly configured
    /// contract information.
    fn metrics_conf(
        &self,
        agent_name: &str,
        signer: &Option<impl HyperlaneSigner>,
    ) -> PrometheusMiddlewareConf {
        let mut cfg = self.metrics_conf.clone();

        if cfg.chain.is_none() {
            cfg.chain = Some(ChainInfo {
                name: Some(self.name.clone()),
            });
        }

        if let Some(signer) = signer {
            cfg.wallets
                .entry(signer.eth_address())
                .or_insert_with(|| WalletInfo {
                    name: Some(agent_name.into()),
                });
        }

        let functions = |m: HashMap<Vec<u8>, String>| {
            m.into_iter()
                .map(|s| (Selector::try_from(s.0).unwrap(), s.1))
                .collect()
        };

        if let Ok(addr) = self.addresses.mailbox.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("mailbox".into()),
                functions: functions(EthereumMailboxAbi::fn_map_owned()),
            });
        }
        if let Ok(addr) = self.addresses.interchain_gas_paymaster.parse() {
            cfg.contracts.entry(addr).or_insert_with(|| ContractInfo {
                name: Some("igp".into()),
                functions: functions(EthereumInterchainGasPaymasterAbi::fn_map_owned()),
            });
        }
        cfg
    }

    fn locator(&self, address: &str) -> Result<ContractLocator> {
        let domain = self
            .domain()
            .context("Invalid domain for locating contract")?;
        let address = match self.connection()? {
            ChainConnectionConf::Ethereum(_) => address
                .parse::<ethers::types::Address>()
                .context("Invalid ethereum address for locating contract")?
                .into(),
            ChainConnectionConf::Fuel(_) => address
                .parse::<fuels::tx::ContractId>()
                .map_err(|e| eyre!("Invalid fuel contract id for locating contract: {e}"))?
                .into_h256(),
        };

        Ok(ContractLocator { domain, address })
    }

    async fn build_ethereum<B>(
        &self,
        conf: &h_eth::ConnectionConf,
        locator: &ContractLocator,
        metrics: &CoreMetrics,
        builder: B,
    ) -> Result<B::Output>
    where
        B: BuildableWithProvider + Sync,
    {
        let signer = self.ethereum_signer().await?;
        let metrics_conf = self.metrics_conf(metrics.agent_name(), &signer);
        let rpc_metrics = Some(metrics.json_rpc_client_metrics());
        let middleware_metrics = Some((metrics.provider_metrics(), metrics_conf));
        let res = builder
            .build_with_connection_conf(conf, locator, signer, rpc_metrics, middleware_metrics)
            .await;
        Ok(res?)
    }
}

use std::collections::HashMap;
use std::fmt::{Display, Formatter};

use ethers::prelude::Selector;
use eyre::{bail, eyre, Context, Result};
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
    EthereumValidatorAnnounceAbi,
};
use hyperlane_fuel as h_fuel;

use crate::settings::signers::RawSignerConf;
use crate::{settings::signers::BuildableWithSignerConf, CoreMetrics, ConfigOptionExt, SignerConf};

/// A connection to _some_ blockchain.
#[derive(Clone, Debug)]
pub enum ChainConnectionConf {
    /// Ethereum configuration
    Ethereum(h_eth::ConnectionConf),
    /// Fuel configuration
    Fuel(h_fuel::ConnectionConf),
}

/// Specify the chain name (enum variant) under the `chain` key
#[derive(Debug, Deserialize)]
#[serde(tag = "protocol", content = "connection", rename_all = "camelCase")]
enum RawChainConnectionConf {
    Ethereum(h_eth::RawConnectionConf),
    Fuel(h_fuel::RawConnectionConf),
    #[serde(other)]
    None,
}

impl TryFrom<RawChainConnectionConf> for ChainConnectionConf {
    type Error = eyre::Report;

    fn try_from(r: RawChainConnectionConf) -> Result<Self, Self::Error> {
        match r {
            RawChainConnectionConf::Ethereum(r) => Ok(Self::Ethereum(r.try_into()?)),
            RawChainConnectionConf::Fuel(r) => Ok(Self::Fuel(r.try_into()?)),
            RawChainConnectionConf::None => Err(eyre!("Unknown chain protocol")),
        }
    }
}

impl ChainConnectionConf {
    fn protocol(&self) -> HyperlaneDomainProtocol {
        match self {
            Self::Ethereum(_) => HyperlaneDomainProtocol::Ethereum,
            Self::Fuel(_) => HyperlaneDomainProtocol::Fuel,
        }
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
#[derive(Clone, Debug, Default)]
pub struct CoreContractAddresses {
    /// Address of the mailbox contract
    pub mailbox: H256,
    /// Address of the InterchainGasPaymaster contract
    pub interchain_gas_paymaster: H256,
    /// Address of the ValidatorAnnounce contract
    pub validator_announce: H256,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCoreContractAddresses {
    mailbox: Option<String>,
    interchain_gas_paymaster: Option<String>,
    validator_announce: Option<String>,
}

impl TryFrom<RawCoreContractAddresses> for CoreContractAddresses {
    type Error = eyre::Report;

    fn try_from(r: RawCoreContractAddresses) -> Result<Self, Self::Error> {
        Ok(Self {
            mailbox: r
                .mailbox
                .expect_or_eyre("Missing `mailbox` core contract address")?
                .parse()
                .context("Invalid hex string for `mailbox` core contract address")?,
            interchain_gas_paymaster: r
                .interchain_gas_paymaster
                .expect_or_eyre("Missing `interchainGasPaymaster` core contract address")?
                .parse()
                .context("Invalid hex string for `interchainGasPaymaster` core contract address")?,
            validator_announce: r
                .validator_announce
                .expect_or_eyre("Missing `validatorAnnounce` core contract address")?
                .parse()
                .context("Invalid hex string for `validatorAnnounce` core contract address")?,
        })
    }
}

/// Indexing settings
#[derive(Debug, Default, Clone)]
pub struct IndexSettings {
    /// The height at which to start indexing the Outbox contract
    pub from: u32,
    /// The number of blocks to query at once at which to start indexing the
    /// Mailbox contract
    pub chunk_size: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndexSettings {
    from: Option<StrOrInt>,
    chunk: Option<StrOrInt>,
}

impl TryFrom<RawIndexSettings> for IndexSettings {
    type Error = eyre::Report;

    fn try_from(r: RawIndexSettings) -> Result<Self, Self::Error> {
        Ok(Self {
            from: r
                .from
                .map(|v| v.try_into())
                .transpose()
                .context("Invalid `from` index setting")?
                .unwrap_or_default(),
            chunk_size: r
                .chunk
                .map(|v| v.try_into())
                .transpose()
                .context("Invalid `chunk` index setting")?
                .unwrap_or(1999),
        })
    }
}

/// A chain setup is a domain ID, an address on that chain (where the mailbox is
/// deployed) and details for connecting to the chain API.
#[derive(Clone, Debug)]
pub struct ChainConf {
    /// The domain
    pub domain: HyperlaneDomain,
    /// Signer configuration for this chain
    pub signer: Option<SignerConf>,
    /// Number of blocks until finality
    pub finality_blocks: u32,
    /// Addresses of contracts on the chain
    pub addresses: CoreContractAddresses,
    /// The chain connection details
    pub connection: Option<ChainConnectionConf>,
    /// How transactions to this chain are submitted.
    pub txsubmission: TransactionSubmissionType,
    /// Configure chain-specific metrics information. This will automatically
    /// add all contract addresses but will not override any set explicitly.
    /// Use `metrics_conf()` to get the metrics.
    pub metrics_conf: PrometheusMiddlewareConf,
    /// Settings for event indexing
    pub index: IndexSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawChainConf {
    name: Option<String>,
    domain: Option<StrOrInt>,
    pub(super) signer: Option<RawSignerConf>,
    finality_blocks: Option<StrOrInt>,
    addresses: Option<RawCoreContractAddresses>,
    #[serde(flatten, default)]
    connection: Option<RawChainConnectionConf>,
    #[serde(default)]
    txsubmission: Option<String>,
    // TODO: if people actually use the metrics conf we should also add a raw form.
    #[serde(default)]
    metrics_conf: Option<PrometheusMiddlewareConf>,
    #[serde(default)]
    index: Option<RawIndexSettings>,
}

impl TryFrom<RawChainConf> for ChainConf {
    type Error = eyre::Report;

    fn try_from(r: RawChainConf) -> Result<ChainConf> {
        let protocol = match r
            .connection
            .as_ref()
            .expect_or_eyre("Missing `protocol` configuration")?
        {
            RawChainConnectionConf::Ethereum(_) => HyperlaneDomainProtocol::Ethereum,
            RawChainConnectionConf::Fuel(_) => HyperlaneDomainProtocol::Fuel,
            RawChainConnectionConf::None => bail!("Unknown `protocol` configuration"),
        };
        Ok(Self {
            domain: HyperlaneDomain::from_config(
                r.domain
                    .as_ref()
                    .expect_or_eyre("Missing `domain` chain configuration")?
                    .try_into()
                    .context("Invalid domain id")?,
                r.name
                    .as_deref()
                    .expect_or_eyre("Missing `name` chain configuration")?,
                protocol,
            )?,
            addresses: r
                .addresses
                .map(|v| v.try_into())
                .transpose()
                .context("Invalid `addresses` chain configuration")?
                .unwrap_or_default(),
            signer: r
                .signer
                .map(|v| v.try_into())
                .transpose()
                .context("Invalid `signer` chain configuration")?,
            finality_blocks: r
                .finality_blocks
                .map(|v| v.try_into())
                .transpose()
                .context("Invalid `finalityBlocks` chain configuration")?
                .unwrap_or(0),
            connection: r
                .connection
                .map(|v| v.try_into())
                .transpose()
                .context("Invalid `connection` chain configuration")?,
            txsubmission: r
                .txsubmission
                .map(|v| serde_json::from_str(&v))
                .transpose()
                .context("Invalid `txsubmission` chain configuration")?
                .unwrap_or_default(),
            index: r
                .index
                .map(|v| v.try_into())
                .transpose()
                .context("Invalid `index` chain configuration")?
                .unwrap_or_default(),
            metrics_conf: r.metrics_conf.unwrap_or_default(),
        })
    }
}

impl Display for RawChainConf {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (", self.name.as_deref().unwrap_or("<unknown>"))?;
        match &self.domain {
            Some(StrOrInt::Str(s)) => write!(f, "{s})"),
            Some(StrOrInt::Int(i)) => write!(f, "{i})"),
            None => write!(f, "<unknown>)"),
        }
    }
}

impl ChainConf {
    /// Get the chain connection config or generate an error
    pub fn connection(&self) -> Result<&ChainConnectionConf> {
        self.connection.as_ref().ok_or_else(|| eyre!("Missing chain configuration for {}; this includes protocol and connection information", self.domain.name()))
    }

    /// Try to convert the chain settings into an HyperlaneProvider.
    pub async fn build_provider(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn HyperlaneProvider>> {
        let ctx = "Building provider";
        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                let locator = self.locator(H256::zero());
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
        let locator = self.locator(self.addresses.mailbox);

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
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::MailboxIndexerBuilder {
                        finality_blocks: self.finality_blocks,
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
        let locator = self.locator(self.addresses.interchain_gas_paymaster);

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
        let locator = self.locator(self.addresses.interchain_gas_paymaster);

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainGasPaymasterIndexerBuilder {
                        mailbox_address: self.addresses.mailbox.into(),
                        finality_blocks: self.finality_blocks,
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
        let locator = self.locator(self.addresses.validator_announce);
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
        let locator = self.locator(address);

        match &self.connection()? {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MultisigIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
        }
        .context(ctx)
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
                name: Some(self.domain.name().into()),
            });
        }

        if let Some(signer) = signer {
            cfg.wallets
                .entry(signer.eth_address())
                .or_insert_with(|| WalletInfo {
                    name: Some(agent_name.into()),
                });
        }

        let mut register_contract = |name: &str, address: H256, fns: HashMap<Vec<u8>, String>| {
            cfg.contracts
                .entry(address.into())
                .or_insert_with(|| ContractInfo {
                    name: Some(name.into()),
                    functions: fns
                        .into_iter()
                        .map(|s| (Selector::try_from(s.0).unwrap(), s.1))
                        .collect(),
                });
        };

        register_contract(
            "mailbox",
            self.addresses.mailbox,
            EthereumMailboxAbi::fn_map_owned(),
        );
        register_contract(
            "va",
            self.addresses.validator_announce,
            EthereumValidatorAnnounceAbi::fn_map_owned(),
        );
        register_contract(
            "igp",
            self.addresses.interchain_gas_paymaster,
            EthereumInterchainGasPaymasterAbi::fn_map_owned(),
        );

        cfg
    }

    fn locator(&self, address: H256) -> ContractLocator {
        ContractLocator {
            domain: &self.domain,
            address,
        }
    }

    async fn build_ethereum<B>(
        &self,
        conf: &h_eth::ConnectionConf,
        locator: &ContractLocator<'_>,
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

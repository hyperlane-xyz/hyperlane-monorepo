//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

#![allow(dead_code)] // TODO(2214): remove before PR merge

use std::cmp::Reverse;
use std::collections::HashMap;

use ethers::prelude::Selector;
use eyre::{eyre, Context, Result};
use itertools::Itertools;
use serde::Deserialize;

use ethers_prometheus::middleware::{
    ChainInfo, ContractInfo, PrometheusMiddlewareConf, WalletInfo,
};
use hyperlane_core::{
    cfg_unwrap_all, config::*, utils::hex_or_base58_to_h256, AggregationIsm, CcipReadIsm,
    ContractLocator, HyperlaneAbi, HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneProvider,
    HyperlaneSigner, IndexMode, Indexer, InterchainGasPaymaster, InterchainGasPayment,
    InterchainSecurityModule, Mailbox, MessageIndexer, MultisigIsm, RoutingIsm, ValidatorAnnounce,
    H256,
};
use hyperlane_ethereum::{
    self as h_eth, BuildableWithProvider, EthereumInterchainGasPaymasterAbi, EthereumMailboxAbi,
    EthereumValidatorAnnounceAbi,
};
use hyperlane_fuel as h_fuel;
use hyperlane_sealevel as h_sealevel;

use crate::{
    settings::signers::{BuildableWithSignerConf, RawSignerConf},
    CoreMetrics, SignerConf,
};

//////////////////////////
// PARSED CONFIG TYPES //
////////////////////////

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
    pub connection: ChainConnectionConf,
    /// Configure chain-specific metrics information. This will automatically
    /// add all contract addresses but will not override any set explicitly.
    /// Use `metrics_conf()` to get the metrics.
    pub metrics_conf: PrometheusMiddlewareConf,
    /// Settings for event indexing
    pub index: IndexSettings,
}

/// A connection to _some_ blockchain.
#[derive(Clone, Debug)]
pub enum ChainConnectionConf {
    /// Ethereum configuration
    Ethereum(h_eth::ConnectionConf),
    /// Fuel configuration
    Fuel(h_fuel::ConnectionConf),
    /// Sealevel configuration.
    Sealevel(h_sealevel::ConnectionConf),
}

impl ChainConnectionConf {
    fn protocol(&self) -> HyperlaneDomainProtocol {
        match self {
            Self::Ethereum(_) => HyperlaneDomainProtocol::Ethereum,
            Self::Fuel(_) => HyperlaneDomainProtocol::Fuel,
            Self::Sealevel(_) => HyperlaneDomainProtocol::Sealevel,
        }
    }
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

/// Indexing settings
#[derive(Debug, Default, Clone)]
pub struct IndexSettings {
    /// The height at which to start indexing contracts.
    pub from: u32,
    /// The number of blocks to query at once when indexing contracts.
    pub chunk_size: u32,
    /// The indexing mode.
    pub mode: IndexMode,
}

////////////////////
// NEW RAW TYPES //
//////////////////

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentConf {
    metrics_port: StrOrInt,
    chains: HashMap<String, RawAgentChainMetadataConf>,
    default_signer: RawSignerConf,
    default_rpc_consensus_type: Option<String>,
    #[serde(default)]
    log: RawAgentLogConf,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentChainMetadataConf {
    // -- AgentChainMetadata --
    #[serde(default)]
    custom_rpc_urls: HashMap<String, RawRpcUrlConf>,
    rpc_consensus_type: Option<RawRpcConsensusType>,
    signer: Option<RawSignerConf>,
    #[serde(default)]
    index: RawAgentChainMetadataIndexConf,

    // -- ChainMetadata --
    protocol: Option<String>,
    chain_id: Option<StrOrInt>,
    domain_id: Option<StrOrInt>,
    name: Option<String>,
    display_name: Option<String>,
    display_name_short: Option<String>,
    logo_uri: Option<String>,
    #[serde(default)]
    native_token: RawNativeTokenConf,
    #[serde(default)]
    rpc_urls: Vec<RawRpcUrlConf>,
    #[serde(default)]
    block_explorers: Vec<RawBlockExplorerConf>,
    #[serde(default)]
    blocks: RawBlockConf,
    #[serde(default)]
    transaction_overrides: HashMap<String, serde_json::Value>,
    gas_currency_coin_geco_id: Option<String>,
    gnosis_safe_transaction_service_url: Option<String>,
    #[serde(default)]
    is_testnet: bool,

    // -- HyperlaneDeploymentArtifacts --
    mailbox: Option<String>,
    interchain_gas_paymaster: Option<String>,
    validator_announce: Option<String>,
    interchain_security_module: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentChainMetadataIndexConf {
    from: Option<StrOrInt>,
    chunk: Option<StrOrInt>,
    mode: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNativeTokenConf {
    name: Option<String>,
    symbol: Option<String>,
    decimals: Option<StrOrInt>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRpcUrlConf {
    http: Option<String>,
    ws: Option<String>,
    #[serde(default)]
    pagination: RawPaginationConf,
    #[serde(default)]
    retry: RawRetryConfig,

    // -- AgentChainMetadata Ext for `custom_rpc_urls` --
    priority: Option<StrOrInt>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPaginationConf {
    max_block_range: Option<StrOrInt>,
    min_block_number: Option<StrOrInt>,
    max_block_age: Option<StrOrInt>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRetryConfig {
    max_requests: Option<StrOrInt>,
    base_retry_ms: Option<StrOrInt>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBlockExplorerConf {
    name: Option<String>,
    url: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    family: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBlockConf {
    confirmations: Option<StrOrInt>,
    reorg_period: Option<StrOrInt>,
    estimate_block_time: Option<StrOrInt>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentLogConf {
    format: Option<String>,
    level: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RawRpcConsensusType {
    Fallback,
    Quorum,
    #[serde(other)]
    Unknown,
}

impl FromRawConf<RawAgentChainMetadataConf> for ChainConf {
    fn from_config_filtered(
        raw: RawAgentChainMetadataConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let domain = (&raw).parse_config(cwp).take_config_err(&mut err);
        let addresses = (&raw).parse_config(cwp).take_config_err(&mut err);

        let signer = raw.signer.and_then(|s| {
            s.parse_config(&cwp.join("signer"))
                .take_config_err(&mut err)
        });

        // TODO(2214): is it correct to define finality blocks as `confirmations` and not `reorgPeriod`?
        // TODO(2214): should we rename `finalityBlocks` in ChainConf?
        let finality_blocks = raw
            .blocks
            .confirmations
            .ok_or_else(|| eyre!("Missing `confirmations`"))
            .take_err(&mut err, || cwp + "confirmations")
            .and_then(|v| {
                v.try_into()
                    .context("Invalid `confirmations`, expected integer")
                    .take_err(&mut err, || cwp + "confirmations")
            });

        let index: Option<IndexSettings> = raw
            .index
            .parse_config_with_filter(&cwp.join("index"), domain.as_ref())
            .take_config_err(&mut err);

        let rpcs: Vec<(ConfigPath, RawRpcUrlConf)> = if raw.custom_rpc_urls.is_empty() {
            let cwp = cwp + "rpc_urls";
            // if no custom rpc urls are set, use the default rpc urls
            raw.rpc_urls
                .into_iter()
                .enumerate()
                .map(|(i, v)| (&cwp + i.to_string(), v))
                .collect()
        } else {
            // use the custom defined urls, sorted by highest prio first
            let cwp = cwp + "custom_rpc_urls";
            raw.custom_rpc_urls
                .into_iter()
                .map(|(k, v)| {
                    (
                        v.priority
                            .as_ref()
                            .and_then(|v| v.try_into().take_err(&mut err, || &cwp + &k))
                            .unwrap_or(0i32),
                        k,
                        v,
                    )
                })
                .sorted_unstable_by_key(|(p, _, _)| Reverse(*p))
                .map(|(_, k, v)| (&cwp + k, v))
                .collect()
        };

        if rpcs.is_empty() {
            err.push(
                cwp + "rpc_urls",
                eyre!("Missing base rpc definitions for chain"),
            );
            err.push(
                cwp + "custom_rpc_urls",
                eyre!("Also missing rpc overrides for chain"),
            );
        }

        cfg_unwrap_all!(cwp, err: index, finality_blocks, domain);

        let connection: Option<ChainConnectionConf> = match domain.domain_protocol() {
            HyperlaneDomainProtocol::Ethereum => {
                if rpcs.len() <= 1 {
                    rpcs.into_iter()
                        .next()
                        .and_then(|(cwp, rpc)| rpc.http.map(|url| (cwp, url)))
                        .and_then(|(cwp, url)| url.parse().take_err(&mut err, || cwp))
                        .map(|url| {
                            ChainConnectionConf::Ethereum(h_eth::ConnectionConf::Http { url })
                        })
                } else {
                    let urls = rpcs
                        .into_iter()
                        .filter_map(|(cwp, rpc)| {
                            let cwp = || &cwp + "http";
                            rpc.http
                                .ok_or_else(|| {
                                    eyre!(
                                        "missing http url for multi-rpc configured ethereum client"
                                    )
                                })
                                .take_err(&mut err, cwp)
                                .and_then(|url| url.parse().take_err(&mut err, cwp))
                        })
                        .collect_vec();

                    match raw
                        .rpc_consensus_type {
                        Some(RawRpcConsensusType::Fallback) => {
                            Some(h_eth::ConnectionConf::HttpFallback { urls })
                        }
                        Some(RawRpcConsensusType::Quorum) => {
                            Some(h_eth::ConnectionConf::HttpQuorum { urls })
                        }
                        Some(RawRpcConsensusType::Unknown) => {
                            err.push(cwp + "rpc_consensus_type", eyre!("unknown rpc consensus type"));
                            None
                        }
                        None => {
                            err.push(cwp + "rpc_consensus_type", eyre!("missing consensus type for multi-rpc configured ethereum client"));
                            None
                        },
                    }
                    .map(ChainConnectionConf::Ethereum)
                }
            }
            HyperlaneDomainProtocol::Fuel => rpcs
                .into_iter()
                .next()
                .and_then(|(cwp, rpc)| rpc.http.map(|url| (cwp, url)))
                .and_then(|(cwp, url)| url.parse().take_err(&mut err, || cwp))
                .map(|url| ChainConnectionConf::Fuel(h_fuel::ConnectionConf { url })),
            HyperlaneDomainProtocol::Sealevel => rpcs
                .into_iter()
                .next()
                .and_then(|(cwp, rpc)| rpc.http.map(|url| (cwp, url)))
                .and_then(|(cwp, url)| url.parse().take_err(&mut err, || cwp))
                .map(|url| ChainConnectionConf::Sealevel(h_sealevel::ConnectionConf { url })),
        };

        cfg_unwrap_all!(cwp, err: addresses, connection);
        err.into_result(Self {
            domain,
            signer,
            finality_blocks,
            addresses,
            connection,
            metrics_conf: Default::default(),
            index,
        })
    }
}

impl FromRawConf<&RawAgentChainMetadataConf> for HyperlaneDomain {
    fn from_config_filtered(
        raw: &RawAgentChainMetadataConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let chain_id = raw
            .chain_id
            .as_ref()
            .ok_or_else(|| eyre!("Missing `chainId`"))
            .take_err(&mut err, || cwp + "chain_id")
            .and_then(|d| {
                d.try_into()
                    .context("Invalid `chainId`, expected integer")
                    .take_err(&mut err, || cwp + "chain_id")
            });

        let domain_id = raw
            .domain_id
            .as_ref()
            .and_then(|d| {
                d.try_into()
                    .context("Invalid `domainId`, expected integer")
                    .take_err(&mut err, || cwp + "domain_id")
            })
            // default to chain id if domain id is not set
            .or(chain_id);

        let protocol = raw
            .protocol
            .as_deref()
            .ok_or_else(|| eyre!("Missing `protocol`"))
            .take_err(&mut err, || cwp + "protocol")
            .and_then(|d| {
                HyperlaneDomainProtocol::try_from(d)
                    .context("Invalid (or unknown) `protocol`")
                    .take_err(&mut err, || cwp + "protocol")
            });

        let name = raw
            .name
            .as_deref()
            .ok_or_else(|| eyre!("Missing chain `name`"))
            .take_err(&mut err, || cwp + "name");

        cfg_unwrap_all!(cwp, err: domain_id, protocol, name);

        let domain = Self::from_config(domain_id, name, protocol)
            .context("Invalid domain data")
            .take_err(&mut err, || cwp.clone());

        cfg_unwrap_all!(cwp, err: domain);
        err.into_result(domain)
    }
}

impl FromRawConf<&RawAgentChainMetadataConf> for CoreContractAddresses {
    fn from_config_filtered(
        raw: &RawAgentChainMetadataConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let mailbox = raw
            .mailbox
            .as_ref()
            .ok_or_else(|| eyre!("Missing `mailbox` address"))
            .take_err(&mut err, || cwp + "mailbox")
            .and_then(|v| hex_or_base58_to_h256(v).take_err(&mut err, || cwp + "mailbox"));

        let interchain_gas_paymaster = raw
            .interchain_gas_paymaster
            .as_ref()
            .ok_or_else(|| eyre!("Missing `interchainGasPaymaster` address"))
            .take_err(&mut err, || cwp + "interchain_gas_paymaster")
            .and_then(|v| {
                hex_or_base58_to_h256(v).take_err(&mut err, || cwp + "interchain_gas_paymaster")
            });

        let validator_announce = raw
            .validator_announce
            .as_ref()
            .ok_or_else(|| eyre!("Missing `validatorAnnounce` address"))
            .take_err(&mut err, || cwp + "validator_announce")
            .and_then(|v| {
                hex_or_base58_to_h256(v).take_err(&mut err, || cwp + "validator_announce")
            });

        cfg_unwrap_all!(cwp, err: mailbox, interchain_gas_paymaster, validator_announce);
        err.into_result(Self {
            mailbox,
            interchain_gas_paymaster,
            validator_announce,
        })
    }
}

impl FromRawConf<RawAgentChainMetadataIndexConf, Option<&HyperlaneDomain>> for IndexSettings {
    fn from_config_filtered(
        raw: RawAgentChainMetadataIndexConf,
        cwp: &ConfigPath,
        domain: Option<&HyperlaneDomain>,
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let from = raw
            .from
            .and_then(|v| v.try_into().take_err(&mut err, || cwp + "from"))
            .unwrap_or_default();

        let chunk_size = raw
            .chunk
            .and_then(|v| v.try_into().take_err(&mut err, || cwp + "chunk"))
            .unwrap_or(1999);

        let mode = raw
            .mode
            .map(serde_json::Value::from)
            .and_then(|m| {
                serde_json::from_value(m)
                    .context("Invalid mode")
                    .take_err(&mut err, || cwp + "mode")
            })
            .or_else(|| {
                // attempt to choose a reasonable default
                domain.and_then(|d| match d.domain_protocol() {
                    HyperlaneDomainProtocol::Ethereum => Some(IndexMode::Block),
                    HyperlaneDomainProtocol::Sealevel => Some(IndexMode::Sequence),
                    _ => None,
                })
            })
            .unwrap_or_default();

        err.into_result(Self {
            from,
            chunk_size,
            mode,
        })
    }
}

///////////////////////////
// DEPRECATED RAW TYPES //
/////////////////////////

#[derive(Deserialize, Debug)]
#[serde(tag = "protocol", content = "connection", rename_all = "camelCase")]
enum DeprecatedRawChainConnectionConf {
    Ethereum(h_eth::RawConnectionConf),
    Fuel(h_fuel::DeprecatedRawConnectionConf),
    Sealevel(h_sealevel::DeprecatedRawConnectionConf),
    #[serde(other)]
    Unknown,
}

impl FromRawConf<DeprecatedRawChainConnectionConf> for ChainConnectionConf {
    fn from_config_filtered(
        raw: DeprecatedRawChainConnectionConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        use DeprecatedRawChainConnectionConf::*;
        match raw {
            Ethereum(r) => Ok(Self::Ethereum(r.parse_config(&cwp.join("connection"))?)),
            Fuel(r) => Ok(Self::Fuel(r.parse_config(&cwp.join("connection"))?)),
            Sealevel(r) => Ok(Self::Sealevel(r.parse_config(&cwp.join("connection"))?)),
            Unknown => {
                Err(eyre!("Unknown chain protocol")).into_config_result(|| cwp.join("protocol"))
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeprecatedRawCoreContractAddresses {
    mailbox: Option<String>,
    interchain_gas_paymaster: Option<String>,
    validator_announce: Option<String>,
}

impl FromRawConf<DeprecatedRawCoreContractAddresses> for CoreContractAddresses {
    fn from_config_filtered(
        raw: DeprecatedRawCoreContractAddresses,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        macro_rules! parse_addr {
            ($name:ident) => {
                let $name = raw
                    .$name
                    .ok_or_else(|| {
                        eyre!(
                            "Missing {} core contract address",
                            stringify!($name).replace('_', " ")
                        )
                    })
                    .take_err(&mut err, || cwp + stringify!($name))
                    .and_then(|v| {
                        hex_or_base58_to_h256(&v).take_err(&mut err, || cwp + stringify!($name))
                    });
            };
        }

        parse_addr!(mailbox);
        parse_addr!(interchain_gas_paymaster);
        parse_addr!(validator_announce);

        cfg_unwrap_all!(cwp, err: mailbox, interchain_gas_paymaster, validator_announce);

        err.into_result(Self {
            mailbox,
            interchain_gas_paymaster,
            validator_announce,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeprecatedRawIndexSettings {
    from: Option<StrOrInt>,
    chunk: Option<StrOrInt>,
    mode: Option<String>,
}

impl FromRawConf<DeprecatedRawIndexSettings> for IndexSettings {
    fn from_config_filtered(
        raw: DeprecatedRawIndexSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let from = raw
            .from
            .and_then(|v| v.try_into().take_err(&mut err, || cwp + "from"))
            .unwrap_or_default();

        let chunk_size = raw
            .chunk
            .and_then(|v| v.try_into().take_err(&mut err, || cwp + "chunk"))
            .unwrap_or(1999);

        let mode = raw
            .mode
            .map(serde_json::Value::from)
            .and_then(|m| {
                serde_json::from_value(m)
                    .context("Invalid mode")
                    .take_err(&mut err, || cwp + "mode")
            })
            .unwrap_or_default();

        err.into_result(Self {
            from,
            chunk_size,
            mode,
        })
    }
}

/// A raw chain setup is a domain ID, an address on that chain (where the
/// mailbox is deployed) and details for connecting to the chain API.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeprecatedRawChainConf {
    name: Option<String>,
    domain: Option<StrOrInt>,
    pub(super) signer: Option<RawSignerConf>,
    finality_blocks: Option<StrOrInt>,
    addresses: Option<DeprecatedRawCoreContractAddresses>,
    #[serde(flatten, default)]
    connection: Option<DeprecatedRawChainConnectionConf>,
    // TODO: if people actually use the metrics conf we should also add a raw form.
    #[serde(default)]
    metrics_conf: Option<PrometheusMiddlewareConf>,
    #[serde(default)]
    index: Option<DeprecatedRawIndexSettings>,
}

impl FromRawConf<DeprecatedRawChainConf> for ChainConf {
    fn from_config_filtered(
        raw: DeprecatedRawChainConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let connection = raw
            .connection
            .ok_or_else(|| eyre!("Missing `connection` configuration"))
            .take_err(&mut err, || cwp + "connection")
            .and_then(|r| r.parse_config(cwp).take_config_err(&mut err));

        let domain = connection.as_ref().and_then(|c: &ChainConnectionConf| {
            let protocol = c.protocol();
            let domain_id = raw
                .domain
                .ok_or_else(|| eyre!("Missing `domain` configuration"))
                .take_err(&mut err, || cwp + "domain")
                .and_then(|r| {
                    r.try_into()
                        .context("Invalid domain id, expected integer")
                        .take_err(&mut err, || cwp + "domain")
                });
            let name = raw
                .name
                .as_deref()
                .ok_or_else(|| eyre!("Missing domain `name` configuration"))
                .take_err(&mut err, || cwp + "name");
            HyperlaneDomain::from_config(domain_id?, name?, protocol)
                .take_err(&mut err, || cwp.clone())
        });

        let addresses = raw
            .addresses
            .ok_or_else(|| eyre!("Missing `addresses` configuration for core contracts"))
            .take_err(&mut err, || cwp + "addresses")
            .and_then(|v| {
                v.parse_config(&cwp.join("addresses"))
                    .take_config_err(&mut err)
            });

        let signer = raw.signer.and_then(|v| -> Option<SignerConf> {
            v.parse_config(&cwp.join("signer"))
                .take_config_err(&mut err)
        });

        let finality_blocks = raw
            .finality_blocks
            .and_then(|v| {
                v.try_into()
                    .context("Invalid `finalityBlocks`, expected integer")
                    .take_err(&mut err, || cwp + "finality_blocks")
            })
            .unwrap_or(0);

        let index = raw
            .index
            .and_then(|v| v.parse_config(&cwp.join("index")).take_config_err(&mut err))
            .unwrap_or_default();

        let metrics_conf = raw.metrics_conf.unwrap_or_default();

        cfg_unwrap_all!(cwp, err: connection, domain, addresses);

        err.into_result(Self {
            connection,
            domain,
            addresses,
            signer,
            finality_blocks,
            index,
            metrics_conf,
        })
    }
}

/////////////////////////
// CHAIN CONF HELPERS //
///////////////////////

impl ChainConf {
    /// Try to convert the chain settings into an HyperlaneProvider.
    pub async fn build_provider(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn HyperlaneProvider>> {
        let ctx = "Building provider";
        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                let locator = self.locator(H256::zero());
                self.build_ethereum(conf, &locator, metrics, h_eth::HyperlaneProviderBuilder {})
                    .await
            }
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => todo!(),
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a Mailbox contract
    pub async fn build_mailbox(&self, metrics: &CoreMetrics) -> Result<Box<dyn Mailbox>> {
        let ctx = "Building provider";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
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
            ChainConnectionConf::Sealevel(conf) => {
                let keypair = self.sealevel_signer().await.context(ctx)?;
                h_sealevel::SealevelMailbox::new(conf, locator, keypair)
                    .map(|m| Box::new(m) as Box<dyn Mailbox>)
                    .map_err(Into::into)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a message indexer
    pub async fn build_message_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MessageIndexer>> {
        let ctx = "Building delivery indexer";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::MessageIndexerBuilder {
                        finality_blocks: self.finality_blocks,
                    },
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let indexer = Box::new(h_sealevel::SealevelMailboxIndexer::new(conf, locator)?);
                Ok(indexer as Box<dyn MessageIndexer>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a delivery indexer
    pub async fn build_delivery_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn Indexer<H256>>> {
        let ctx = "Building delivery indexer";
        let locator = self.locator(self.addresses.mailbox);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::DeliveryIndexerBuilder {
                        finality_blocks: self.finality_blocks,
                    },
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let indexer = Box::new(h_sealevel::SealevelMailboxIndexer::new(conf, locator)?);
                Ok(indexer as Box<dyn Indexer<H256>>)
            }
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

        match &self.connection {
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
            ChainConnectionConf::Sealevel(conf) => {
                let paymaster = Box::new(h_sealevel::SealevelInterchainGasPaymaster::new(
                    conf, locator,
                ));
                Ok(paymaster as Box<dyn InterchainGasPaymaster>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a gas payment indexer
    pub async fn build_interchain_gas_payment_indexer(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn Indexer<InterchainGasPayment>>> {
        let ctx = "Building IGP indexer";
        let locator = self.locator(self.addresses.interchain_gas_paymaster);

        match &self.connection {
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
            ChainConnectionConf::Sealevel(conf) => {
                let indexer = Box::new(h_sealevel::SealevelInterchainGasPaymasterIndexer::new(
                    conf, locator,
                ));
                Ok(indexer as Box<dyn Indexer<InterchainGasPayment>>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain settings into a ValidatorAnnounce
    pub async fn build_validator_announce(
        &self,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn ValidatorAnnounce>> {
        let locator = self.locator(self.addresses.validator_announce);
        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::ValidatorAnnounceBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let va = Box::new(h_sealevel::SealevelValidatorAnnounce::new(conf, locator));
                Ok(va as Box<dyn ValidatorAnnounce>)
            }
        }
        .context("Building ValidatorAnnounce")
    }

    /// Try to convert the chain setting into an InterchainSecurityModule
    /// contract
    pub async fn build_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn InterchainSecurityModule>> {
        let ctx = "Building ISM";
        let locator = self.locator(address);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(
                    conf,
                    &locator,
                    metrics,
                    h_eth::InterchainSecurityModuleBuilder {},
                )
                .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let keypair = self.sealevel_signer().await.context(ctx)?;
                let ism = Box::new(h_sealevel::SealevelInterchainSecurityModule::new(
                    conf, locator, keypair,
                ));
                Ok(ism as Box<dyn InterchainSecurityModule>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a Multisig Ism contract
    pub async fn build_multisig_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn MultisigIsm>> {
        let ctx = "Building multisig ISM";
        let locator = self.locator(address);

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::MultisigIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(conf) => {
                let keypair = self.sealevel_signer().await.context(ctx)?;
                let ism = Box::new(h_sealevel::SealevelMultisigIsm::new(conf, locator, keypair));
                Ok(ism as Box<dyn MultisigIsm>)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a RoutingIsm Ism contract
    pub async fn build_routing_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn RoutingIsm>> {
        let ctx = "Building routing ISM";
        let locator = ContractLocator {
            domain: &self.domain,
            address,
        };

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::RoutingIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => {
                Err(eyre!("Sealevel does not support routing ISM yet")).context(ctx)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into an AggregationIsm Ism contract
    pub async fn build_aggregation_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn AggregationIsm>> {
        let ctx = "Building aggregation ISM";
        let locator = ContractLocator {
            domain: &self.domain,
            address,
        };

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::AggregationIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => {
                Err(eyre!("Sealevel does not support aggregation ISM yet")).context(ctx)
            }
        }
        .context(ctx)
    }

    /// Try to convert the chain setting into a CcipRead Ism contract
    pub async fn build_ccip_read_ism(
        &self,
        address: H256,
        metrics: &CoreMetrics,
    ) -> Result<Box<dyn CcipReadIsm>> {
        let ctx = "Building CcipRead ISM";
        let locator = ContractLocator {
            domain: &self.domain,
            address,
        };

        match &self.connection {
            ChainConnectionConf::Ethereum(conf) => {
                self.build_ethereum(conf, &locator, metrics, h_eth::CcipReadIsmBuilder {})
                    .await
            }

            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => {
                Err(eyre!("Sealevel does not support CCIP read ISM yet")).context(ctx)
            }
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

    async fn sealevel_signer(&self) -> Result<Option<h_sealevel::Keypair>> {
        self.signer().await
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
                .entry(signer.eth_address().into())
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
            "validator_announce",
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

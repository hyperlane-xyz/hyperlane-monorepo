//! This module is responsible for parsing the agent's settings.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

#![allow(dead_code)] // TODO(2214): remove before PR merge

use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use eyre::{eyre, Context};
use hyperlane_core::{
    cfg_unwrap_all, config::*, utils::hex_or_base58_to_h256, HyperlaneDomain,
    HyperlaneDomainProtocol, IndexMode,
};
use itertools::Itertools;
use serde::Deserialize;
use serde_json::json;

pub use super::envs::*;
use crate::settings::{
    chains::IndexSettings, trace::TracingConfig, ChainConf, ChainConnectionConf,
    CheckpointSyncerConf, CoreContractAddresses, Settings, SignerConf,
};

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

/// Raw signer types
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawSignerConf {
    #[serde(rename = "type")]
    signer_type: Option<String>,
    key: Option<String>,
    id: Option<String>,
    region: Option<String>,
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

/// Raw checkpoint syncer types
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RawCheckpointSyncerConf {
    /// A local checkpoint syncer
    LocalStorage {
        /// Path
        path: Option<String>,
    },
    /// A checkpoint syncer on S3
    S3 {
        /// Bucket name
        bucket: Option<String>,
        /// S3 Region
        region: Option<String>,
    },
    /// Unknown checkpoint syncer type was specified
    #[serde(other)]
    Unknown,
}

impl FromRawConf<RawAgentConf, Option<&HashSet<&str>>> for Settings {
    fn from_config_filtered(
        raw: RawAgentConf,
        cwp: &ConfigPath,
        filter: Option<&HashSet<&str>>,
    ) -> Result<Self, ConfigParsingError> {
        let mut err = ConfigParsingError::default();

        let metrics_port = raw
            .metrics_port
            .try_into()
            .take_err(&mut err, || cwp + "metrics_port")
            .unwrap_or(9090);

        let tracing = raw
            .log
            .parse_config(&cwp.join("log"))
            .take_config_err(&mut err);

        let raw_chains = if let Some(filter) = filter {
            raw.chains
                .into_iter()
                .filter(|(k, _)| filter.contains(&**k))
                .collect()
        } else {
            raw.chains
        };

        let chains_path = cwp + "chains";
        let chains = raw_chains
            .into_iter()
            .filter_map(|(name, chain)| {
                let cwp = &chains_path + &name;
                chain
                    .parse_config::<ChainConf>(&cwp)
                    .take_config_err(&mut err)
                    .and_then(|c| {
                        (c.domain.name() == name)
                            .then_some((name, c))
                            .ok_or_else(|| {
                                eyre!("detected chain name mismatch, the config may be corrupted")
                            })
                            .take_err(&mut err, || &cwp + "name")
                    })
            })
            .collect();

        cfg_unwrap_all!(cwp, err: [tracing]);

        err.into_result(Self {
            chains,
            metrics_port,
            tracing,
        })
    }
}

impl FromRawConf<RawAgentLogConf> for TracingConfig {
    fn from_config_filtered(
        raw: RawAgentLogConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let fmt = raw
            .format
            .and_then(|fmt| serde_json::from_value(json!(fmt)).take_err(&mut err, || cwp + "fmt"))
            .unwrap_or_default();

        let level = raw
            .level
            .and_then(|lvl| serde_json::from_value(json!(lvl)).take_err(&mut err, || cwp + "level"))
            .unwrap_or_default();

        err.into_result(Self { fmt, level })
    }
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

        cfg_unwrap_all!(cwp, err: [index, finality_blocks, domain]);

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

        cfg_unwrap_all!(cwp, err: [addresses, connection]);
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

        cfg_unwrap_all!(cwp, err: [domain_id, protocol, name]);

        let domain = Self::from_config(domain_id, name, protocol)
            .context("Invalid domain data")
            .take_err(&mut err, || cwp.clone());

        cfg_unwrap_all!(cwp, err: [domain]);
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

        cfg_unwrap_all!(cwp, err: [mailbox, interchain_gas_paymaster, validator_announce]);
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

impl FromRawConf<RawSignerConf> for SignerConf {
    fn from_config_filtered(
        raw: RawSignerConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let key_path = || cwp + "key";
        let region_path = || cwp + "region";

        match raw.signer_type.as_deref() {
            Some("hexKey") => Ok(Self::HexKey {
                key: raw
                    .key
                    .ok_or_else(|| eyre!("Missing `key` for HexKey signer"))
                    .into_config_result(key_path)?
                    .parse()
                    .into_config_result(key_path)?,
            }),
            Some("aws") => Ok(Self::Aws {
                id: raw
                    .id
                    .ok_or_else(|| eyre!("Missing `id` for Aws signer"))
                    .into_config_result(|| cwp + "id")?,
                region: raw
                    .region
                    .ok_or_else(|| eyre!("Missing `region` for Aws signer"))
                    .into_config_result(region_path)?
                    .parse()
                    .into_config_result(region_path)?,
            }),
            Some(t) => Err(eyre!("Unknown signer type `{t}`")).into_config_result(|| cwp + "type"),
            None if raw.key.is_some() => Ok(Self::HexKey {
                key: raw.key.unwrap().parse().into_config_result(key_path)?,
            }),
            None if raw.id.is_some() | raw.region.is_some() => Ok(Self::Aws {
                id: raw
                    .id
                    .ok_or_else(|| eyre!("Missing `id` for Aws signer"))
                    .into_config_result(|| cwp + "id")?,
                region: raw
                    .region
                    .ok_or_else(|| eyre!("Missing `region` for Aws signer"))
                    .into_config_result(region_path)?
                    .parse()
                    .into_config_result(region_path)?,
            }),
            None => Ok(Self::Node),
        }
    }
}

impl FromRawConf<RawCheckpointSyncerConf> for CheckpointSyncerConf {
    fn from_config_filtered(
        raw: RawCheckpointSyncerConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        match raw {
            RawCheckpointSyncerConf::LocalStorage { path } => {
                let path: PathBuf = path
                    .ok_or_else(|| eyre!("Missing `path` for LocalStorage checkpoint syncer"))
                    .into_config_result(|| cwp + "path")?
                    .parse()
                    .into_config_result(|| cwp + "path")?;
                if !path.exists() {
                    std::fs::create_dir_all(&path)
                        .with_context(|| {
                            format!(
                                "Failed to create local checkpoint syncer storage directory at {:?}",
                                path
                            )
                        })
                        .into_config_result(|| cwp + "path")?;
                } else if !path.is_dir() {
                    Err(eyre!(
                        "LocalStorage checkpoint syncer path is not a directory"
                    ))
                    .into_config_result(|| cwp + "path")?;
                }
                Ok(Self::LocalStorage { path })
            }
            RawCheckpointSyncerConf::S3 { bucket, region } => Ok(Self::S3 {
                bucket: bucket
                    .ok_or_else(|| eyre!("Missing `bucket` for S3 checkpoint syncer"))
                    .into_config_result(|| cwp + "bucket")?,
                region: region
                    .ok_or_else(|| eyre!("Missing `region` for S3 checkpoint syncer"))
                    .into_config_result(|| cwp + "region")?
                    .parse()
                    .into_config_result(|| cwp + "region")?,
            }),
            RawCheckpointSyncerConf::Unknown => Err(eyre!("Missing `type` for checkpoint syncer"))
                .into_config_result(|| cwp + "type"),
        }
    }
}

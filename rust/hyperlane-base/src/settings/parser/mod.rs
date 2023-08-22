//! This module is responsible for parsing the agent's settings.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

#![allow(dead_code)] // TODO(2214): remove before PR merge

use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    default::Default,
};

use eyre::{eyre, Context};
use hyperlane_core::{
    cfg_unwrap_all, config::*, HyperlaneDomain, HyperlaneDomainProtocol, IndexMode,
};
use itertools::Itertools;
use serde::Deserialize;
use serde_json::Value;

pub use self::{json_value_parser::ValueParser, parse_pipe::parse};
pub use super::envs::*;
use crate::settings::{
    chains::IndexSettings, trace::TracingConfig, ChainConf, ChainConnectionConf,
    CheckpointSyncerConf, CoreContractAddresses, Settings, SignerConf,
};

mod json_value_parser;
mod parse_pipe;

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawAgentConf(Value);

impl FromRawConf<RawAgentConf, Option<&HashSet<&str>>> for Settings {
    fn from_config_filtered(
        raw: RawAgentConf,
        cwp: &ConfigPath,
        filter: Option<&HashSet<&str>>,
    ) -> Result<Self, ConfigParsingError> {
        let mut err = ConfigParsingError::default();

        let p = ValueParser::new(cwp.clone(), &raw.0);

        let metrics_port = parse! {
            p(err)
            |> get_opt_key("metricsPort")??
            |> parse_u16()?
            || 9090
        };

        let fmt = parse! {
            p(err)
            |> get_opt_key("log")??
            |> get_opt_key("format")??
            |> parse_value("Invalid log format")?
            || Default
        };

        let level = parse! {
            p(err)
            |> get_opt_key("log")??
            |> get_opt_key("level")??
            |> parse_value("Invalid log level")?
            || Default
        };

        let raw_chains: Vec<(String, ValueParser)> = if let Some(filter) = filter {
            parse! {
                p(err)
                |> get_opt_key("chains")??
                |> into_obj_iter()?
                |> filter(|(k, _)| filter.contains(&**k))
                |> collect()
            }
        } else {
            parse! {
                p(err)
                |> get_opt_key("chains")??
                |> into_obj_iter()?
                |> collect()
            }
        }
        .unwrap_or_default();

        let default_signer = parse! {
            p(err)
            |> get_opt_key("defaultSigner")??
            @> parse_signer()?
        };

        let chains: HashMap<String, ChainConf> = raw_chains
            .into_iter()
            .filter_map(|(name, chain)| {
                (parse! { chain(err) @> parse_chain(&*name)? }).map(|v| (name, v))
            })
            .map(|(name, mut chain)| {
                if let Some(default_signer) = &default_signer {
                    chain.signer.get_or_insert_with(|| default_signer.clone());
                }
                (name, chain)
            })
            .collect();

        err.into_result(Self {
            chains,
            metrics_port,
            tracing: TracingConfig { fmt, level },
        })
    }
}

/// The chain name and ChainMetadata
fn parse_chain(chain: ValueParser, name: &str) -> ConfigResult<ChainConf> {
    let mut err = ConfigParsingError::default();

    let domain = parse! { chain(err) @> parse_domain(name)? };
    let signer = parse! { chain(err) |> get_opt_key("signer")?? @> parse_signer()? };

    // TODO(2214): is it correct to define finality blocks as `confirmations` and not `reorgPeriod`?
    // TODO(2214): should we rename `finalityBlocks` in ChainConf?
    let finality_blocks = parse! {
        chain(err)
        |> get_opt_key("blocks")??
        |> get_key("confirmations")?
        |> parse_u32()?
        || 1
    };

    let rpcs: Vec<ValueParser> = if let Some(custom_rpc_urls) =
        chain.get_opt_key("customRpcUrls").unwrap_or_default()
    {
        // use the custom defined urls, sorted by highest prio first
        parse! {
            custom_rpc_urls(err)
            |> into_obj_iter()?
            |> map(|(_, url)| (parse! { url(err) |> get_opt_key("priority")?? |> parse_i32()? || 0 }, url))
            |> sorted_unstable_by_key(|(p, _)| Reverse(*p))
            |> map(|(_, url)| url)
            |> collect()
        }
    } else {
        // if no custom rpc urls are set, use the default rpc urls
        parse! {
            chain(err)
            |> get_key("rpcUrls")?
            |> into_array_iter()?
            |> collect()
        }
    }.unwrap_or_default();

    if rpcs.is_empty() {
        err.push(
            &chain.cwp + "rpc_urls",
            eyre!("Missing base rpc definitions for chain"),
        );
        err.push(
            &chain.cwp + "custom_rpc_urls",
            eyre!("Also missing rpc overrides for chain"),
        );
    }

    let from = parse! {
        chain(err)
        |> get_opt_key("index")??
        |> get_opt_key("from")??
        |> parse_u32()?
        || 0
    };
    let chunk_size = parse! {
        chain(err)
        |> get_opt_key("index")??
        |> get_opt_key("chunk")??
        |> parse_u32()?
        || 1999
    };
    let mode = parse! {
        chain(err)
        |> get_opt_key("index")??
        |> get_opt_key("mode")??
        |> parse_value("Invalid index mode")?
        || domain.as_ref().and_then(|d| match d.domain_protocol() {
            HyperlaneDomainProtocol::Ethereum => Some(IndexMode::Block),
            HyperlaneDomainProtocol::Sealevel => Some(IndexMode::Sequence),
            _ => None,
        }).unwrap_or_default()
    };

    let mailbox = parse! {
        chain(err)
        |> get_key("mailbox")?
        |> parse_address_hash()?
    };
    let interchain_gas_paymaster = parse! {
        chain(err)
        |> get_key("interchainGasPaymaster")?
        |> parse_address_hash()?
    };
    let validator_announce = parse! {
        chain(err)
        |> get_key("validatorAnnounce")?
        |> parse_address_hash()?
    };

    cfg_unwrap_all!(&chain.cwp, err: [domain]);

    let connection: Option<ChainConnectionConf> = match domain.domain_protocol() {
        HyperlaneDomainProtocol::Ethereum => {
            if rpcs.len() <= 1 {
                let into_connection =
                    |url| ChainConnectionConf::Ethereum(h_eth::ConnectionConf::Http { url });
                rpcs.into_iter().next().and_then(|rpc| {
                    parse! {
                        rpc(err)
                        |> get_key("http")?
                        |> parse_from_str("Invalid http url")?
                        @> into_connection()
                    }
                })
            } else {
                let urls = rpcs
                    .into_iter()
                    .filter_map(|rpc| {
                        parse! {
                            rpc(err)
                            |> get_key("http")?
                            |> parse_from_str("Invalid http url")?
                        }
                    })
                    .collect_vec();

                let rpc_consensus_type = parse! {
                    chain(err)
                    |> get_opt_key("rpcConsensusType")??
                    |> parse_string()?
                    || "fallback"
                };
                match rpc_consensus_type {
                    "fallback" => Some(h_eth::ConnectionConf::HttpFallback { urls }),
                    "quorum" => Some(h_eth::ConnectionConf::HttpQuorum { urls }),
                    ty => Err(eyre!("unknown rpc consensus type `{ty}`"))
                        .take_err(&mut err, || &chain.cwp + "rpc_consensus_type"),
                }
                .map(ChainConnectionConf::Ethereum)
            }
        }
        HyperlaneDomainProtocol::Fuel => rpcs
            .into_iter()
            .next()
            .and_then(|rpc| {
                parse! {
                    rpc(err)
                    |> get_key("http")?
                    |> parse_from_str("Invalid http url")?
                }
            })
            .map(|url| ChainConnectionConf::Fuel(h_fuel::ConnectionConf { url })),
        HyperlaneDomainProtocol::Sealevel => rpcs
            .into_iter()
            .next()
            .and_then(|rpc| {
                parse! {
                    rpc(err)
                    |> get_key("http")?
                    |> parse_from_str("Invalid http url")?
                }
            })
            .map(|url| ChainConnectionConf::Sealevel(h_sealevel::ConnectionConf { url })),
    };

    cfg_unwrap_all!(&chain.cwp, err: [connection, mailbox, interchain_gas_paymaster, validator_announce]);
    err.into_result(ChainConf {
        domain,
        signer,
        finality_blocks,
        addresses: CoreContractAddresses {
            mailbox,
            interchain_gas_paymaster,
            validator_announce,
        },
        connection,
        metrics_conf: Default::default(),
        index: IndexSettings {
            from,
            chunk_size,
            mode,
        },
    })
}

/// Expects ChainMetadata
fn parse_domain(chain: ValueParser, name: &str) -> ConfigResult<HyperlaneDomain> {
    let mut err = ConfigParsingError::default();
    let internal_name = parse! {
        chain(err)
        |> get_key("name")?
        |> parse_string()?
    };

    if let Some(internal_name) = internal_name {
        if internal_name != name {
            Err(eyre!(
                "detected chain name mismatch, the config may be corrupted"
            ))
        } else {
            Ok(())
        }
    } else {
        Err(eyre!("missing chain name, the config may be corrupted"))
    }
    .take_err(&mut err, || &chain.cwp + "name");

    let domain_id = parse! {
        chain(err)
        |> get_opt_key("domainId")??
        |> parse_u32()?
    }
    .or_else(|| {
        parse! {
            chain(err)
            |> get_key("chainId")?
            |> parse_u32()?
        }
    });

    let parse_protocol = |proto| {
        HyperlaneDomainProtocol::try_from(proto).into_config_result(|| &chain.cwp + "protocol")
    };
    let protocol = parse! {
        chain(err)
        |> get_key("protocol")?
        |> parse_string()?
        @> parse_protocol()?
    };

    cfg_unwrap_all!(&chain.cwp, err: [domain_id, protocol]);

    let domain = HyperlaneDomain::from_config(domain_id, name, protocol)
        .context("Invalid domain data")
        .take_err(&mut err, || chain.cwp.clone());

    cfg_unwrap_all!(&chain.cwp, err: [domain]);
    err.into_result(domain)
}

/// Expects AgentSigner.
fn parse_signer(signer: ValueParser) -> ConfigResult<SignerConf> {
    let mut err = ConfigParsingError::default();

    let signer_type = parse! {
        signer(err)
        |> get_opt_key("signerType")??
        |> parse_string()?
    };

    let key_is_some = signer.get_opt_key("key").unwrap_or_default().is_some();
    let id_is_some = signer.get_opt_key("id").unwrap_or_default().is_some();
    let region_is_some = signer.get_opt_key("region").unwrap_or_default().is_some();

    macro_rules! parse_signer {
        (hexKey) => {{
            let key = parse! {
                signer(err)
                |> get_key("key")?
                |> parse_private_key()?
                || Default
            };
            err.into_result(SignerConf::HexKey { key })
        }};
        (aws) => {{
            let id = parse! {
                signer(err)
                |> get_key("id")?
                |> parse_string()?
                |> to_owned()
                || Default
            };
            let region = parse! {
                signer(err)
                |> get_key("region")?
                |> parse_from_str("Expected AWS region")?
                || Default
            };
            err.into_result(SignerConf::Aws { id, region })
        }};
    }

    match signer_type {
        Some("hexKey") => parse_signer!(hexKey),
        Some("aws") => parse_signer!(aws),
        Some(t) => {
            Err(eyre!("Unknown signer type `{t}`")).into_config_result(|| &signer.cwp + "type")
        }
        None if key_is_some => parse_signer!(hexKey),
        None if id_is_some | region_is_some => parse_signer!(aws),
        None => Ok(SignerConf::Node),
    }
}

/// Expects ValidatorAgentConfig.checkpointSyncer
fn parse_checkpoint_syncer(syncer: ValueParser) -> ConfigResult<CheckpointSyncerConf> {
    let mut err = ConfigParsingError::default();
    let syncer_type = parse! {
        syncer(err)
        |> get_key("type")?
        |> parse_string()?
    };

    match syncer_type {
        Some("localStorage") => {
            let path = parse! {
                syncer(err)
                |> get_key("path")?
                |> parse_from_str("Expected file path")?
            };
            cfg_unwrap_all!(&syncer.cwp, err: [path]);
            err.into_result(CheckpointSyncerConf::LocalStorage { path })
        }
        Some("s3") => {
            let bucket = parse! {
                syncer(err)
                |> get_key("bucket")?
                |> parse_string()?
                |> to_owned()
            };
            let region = parse! {
                syncer(err)
                |> get_key("region")?
                |> parse_from_str("Expected aws region")?
            };
            cfg_unwrap_all!(&syncer.cwp, err: [bucket, region]);
            err.into_result(CheckpointSyncerConf::S3 { bucket, region })
        }
        Some(_) => {
            Err(eyre!("Unknown checkpoint syncer type")).into_config_result(|| &syncer.cwp + "type")
        }
        None => Err(err),
    }
}

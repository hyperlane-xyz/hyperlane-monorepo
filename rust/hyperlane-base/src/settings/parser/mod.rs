//! This module is responsible for parsing the agent's settings.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{
    collections::{HashMap, HashSet},
    default::Default,
};

use convert_case::{Case, Casing};
use eyre::{eyre, Context};
use hyperlane_core::{
    cfg_unwrap_all, config::*, HyperlaneDomain, HyperlaneDomainProtocol, IndexMode,
};
use itertools::Itertools;
use serde::Deserialize;
use serde_json::Value;

pub use self::json_value_parser::ValueParser;
pub use super::envs::*;
use crate::settings::{
    chains::IndexSettings, trace::TracingConfig, ChainConf, ChainConnectionConf,
    CoreContractAddresses, Settings, SignerConf,
};

mod json_value_parser;

/// The base agent config
#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct RawAgentConf(Value);

impl FromRawConf<RawAgentConf, Option<&HashSet<&str>>> for Settings {
    fn from_config_filtered(
        raw: RawAgentConf,
        cwp: &ConfigPath,
        filter: Option<&HashSet<&str>>,
    ) -> Result<Self, ConfigParsingError> {
        let mut err = ConfigParsingError::default();

        let p = ValueParser::new(cwp.clone(), &raw.0);

        let metrics_port = p
            .chain(&mut err)
            .get_opt_key("metricsPort")
            .parse_u16()
            .unwrap_or(9090);

        let fmt = p
            .chain(&mut err)
            .get_opt_key("log")
            .get_opt_key("format")
            .parse_value("Invalid log format")
            .unwrap_or_default();

        let level = p
            .chain(&mut err)
            .get_opt_key("log")
            .get_opt_key("level")
            .parse_value("Invalid log level")
            .unwrap_or_default();

        let raw_chains: Vec<(String, ValueParser)> = if let Some(filter) = filter {
            p.chain(&mut err)
                .get_opt_key("chains")
                .into_obj_iter()
                .map(|v| v.filter(|(k, _)| filter.contains(&**k)).collect())
        } else {
            p.chain(&mut err)
                .get_opt_key("chains")
                .into_obj_iter()
                .map(|v| v.collect())
        }
        .unwrap_or_default();

        let default_signer = p
            .chain(&mut err)
            .get_opt_key("defaultSigner")
            .and_then(parse_signer)
            .end();

        let default_rpc_consensus_type = p
            .chain(&mut err)
            .get_opt_key("defaultRpcConsensusType")
            .parse_string()
            .unwrap_or("fallback");

        let chains: HashMap<String, ChainConf> = raw_chains
            .into_iter()
            .filter_map(|(name, chain)| {
                parse_chain(chain, &name, default_rpc_consensus_type)
                    .take_config_err(&mut err)
                    .map(|v| (name, v))
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
fn parse_chain(
    chain: ValueParser,
    name: &str,
    default_rpc_consensus_type: &str,
) -> ConfigResult<ChainConf> {
    let mut err = ConfigParsingError::default();

    let domain = parse_domain(chain.clone(), name).take_config_err(&mut err);
    let signer = chain
        .chain(&mut err)
        .get_opt_key("signer")
        .and_then(parse_signer)
        .end();

    let finality_blocks = chain
        .chain(&mut err)
        .get_opt_key("blocks")
        .get_key("confirmations")
        .parse_u32()
        .unwrap_or(1);

    let rpcs_base = chain
        .chain(&mut err)
        .get_key("rpcUrls")
        .into_array_iter()
        .map(|urls| {
            urls.filter_map(|v| {
                v.chain(&mut err)
                    .get_key("http")
                    .parse_from_str("Invalid http url")
                    .end()
            })
            .collect_vec()
        })
        .unwrap_or_default();

    let rpc_overrides = chain
        .chain(&mut err)
        .get_opt_key("customRpcUrls")
        .parse_string()
        .end()
        .map(|urls| {
            urls.split(',')
                .filter_map(|url| {
                    url.parse()
                        .take_err(&mut err, || &chain.cwp + "customRpcUrls")
                })
                .collect_vec()
        });

    let rpcs = rpc_overrides.unwrap_or(rpcs_base);

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

    let from = chain
        .chain(&mut err)
        .get_opt_key("index")
        .get_opt_key("from")
        .parse_u32()
        .unwrap_or(0);
    let chunk_size = chain
        .chain(&mut err)
        .get_opt_key("index")
        .get_opt_key("chunk")
        .parse_u32()
        .unwrap_or(1999);
    let mode = chain
        .chain(&mut err)
        .get_opt_key("index")
        .get_opt_key("mode")
        .parse_value("Invalid index mode")
        .unwrap_or_else(|| {
            domain
                .as_ref()
                .and_then(|d| match d.domain_protocol() {
                    HyperlaneDomainProtocol::Ethereum => Some(IndexMode::Block),
                    HyperlaneDomainProtocol::Sealevel => Some(IndexMode::Sequence),
                    _ => None,
                })
                .unwrap_or_default()
        });

    let mailbox = chain
        .chain(&mut err)
        .get_key("mailbox")
        .parse_address_hash()
        .end();
    let interchain_gas_paymaster = chain
        .chain(&mut err)
        .get_key("interchainGasPaymaster")
        .parse_address_hash()
        .end();
    let validator_announce = chain
        .chain(&mut err)
        .get_key("validatorAnnounce")
        .parse_address_hash()
        .end();
    let merkle_tree_hook = chain
        .chain(&mut err)
        .get_opt_key("merkleTreeHook")
        .parse_address_hash()
        .end();

    cfg_unwrap_all!(&chain.cwp, err: [domain]);

    let connection: Option<ChainConnectionConf> = match domain.domain_protocol() {
        HyperlaneDomainProtocol::Ethereum => {
            if rpcs.len() <= 1 {
                rpcs.into_iter()
                    .next()
                    .map(|url| ChainConnectionConf::Ethereum(h_eth::ConnectionConf::Http { url }))
            } else {
                let rpc_consensus_type = chain
                    .chain(&mut err)
                    .get_opt_key("rpcConsensusType")
                    .parse_string()
                    .unwrap_or(default_rpc_consensus_type);
                match rpc_consensus_type {
                    "single" => Some(h_eth::ConnectionConf::Http {
                        url: rpcs.into_iter().next().unwrap(),
                    }),
                    "fallback" => Some(h_eth::ConnectionConf::HttpFallback { urls: rpcs }),
                    "quorum" => Some(h_eth::ConnectionConf::HttpQuorum { urls: rpcs }),
                    ty => Err(eyre!("unknown rpc consensus type `{ty}`"))
                        .take_err(&mut err, || &chain.cwp + "rpc_consensus_type"),
                }
                .map(ChainConnectionConf::Ethereum)
            }
        }
        HyperlaneDomainProtocol::Fuel => rpcs
            .into_iter()
            .next()
            .map(|url| ChainConnectionConf::Fuel(h_fuel::ConnectionConf { url })),
        HyperlaneDomainProtocol::Sealevel => rpcs
            .into_iter()
            .next()
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
            merkle_tree_hook,
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
    let internal_name = chain.chain(&mut err).get_key("name").parse_string().end();

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

    let domain_id = chain
        .chain(&mut err)
        .get_opt_key("domainId")
        .parse_u32()
        .end()
        .or_else(|| chain.chain(&mut err).get_key("chainId").parse_u32().end());

    let protocol = chain
        .chain(&mut err)
        .get_key("protocol")
        .parse_from_str::<HyperlaneDomainProtocol>("Invalid Hyperlane domain protocol")
        .end();

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

    let signer_type = signer
        .chain(&mut err)
        .get_opt_key("signerType")
        .parse_string()
        .end();

    let key_is_some = matches!(signer.get_opt_key("key"), Ok(Some(_)));
    let id_is_some = matches!(signer.get_opt_key("id"), Ok(Some(_)));
    let region_is_some = matches!(signer.get_opt_key("region"), Ok(Some(_)));

    macro_rules! parse_signer {
        (hexKey) => {{
            let key = signer
                .chain(&mut err)
                .get_key("key")
                .parse_private_key()
                .unwrap_or_default();
            err.into_result(SignerConf::HexKey { key })
        }};
        (aws) => {{
            let id = signer
                .chain(&mut err)
                .get_key("id")
                .parse_string()
                .unwrap_or("")
                .to_owned();
            let region = signer
                .chain(&mut err)
                .get_key("region")
                .parse_from_str("Expected AWS region")
                .unwrap_or_default();
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

/// Parser for agent signers.
#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct RawAgentSignerConf(Value);

impl FromRawConf<RawAgentSignerConf> for SignerConf {
    fn from_config_filtered(
        raw: RawAgentSignerConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        parse_signer(ValueParser::new(cwp.clone(), &raw.0))
    }
}

/// Recursively re-cases a json value's keys to the given case.
pub fn recase_json_value(mut val: Value, case: Case) -> Value {
    match &mut val {
        Value::Array(ary) => {
            for i in ary {
                let val = recase_json_value(i.take(), case);
                *i = val;
            }
        }
        Value::Object(obj) => {
            let keys = obj.keys().cloned().collect_vec();
            for key in keys {
                let val = obj.remove(&key).unwrap();
                obj.insert(key.to_case(case), recase_json_value(val, case));
            }
        }
        _ => {}
    }
    val
}

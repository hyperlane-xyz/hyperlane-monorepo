//! This module is responsible for parsing the agent's settings.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{
    collections::{HashMap, HashSet},
    default::Default,
    time::Duration,
};

use convert_case::{Case, Casing};
use eyre::{eyre, Context};
use itertools::Itertools;
use serde::Deserialize;
use serde_json::Value;
use url::Url;

use h_cosmos::RawCosmosAmount;
use hyperlane_core::{
    cfg_unwrap_all, config::*, HyperlaneDomain, HyperlaneDomainProtocol,
    HyperlaneDomainTechnicalStack, IndexMode, ReorgPeriod, SubmitterType,
};

use crate::settings::{
    chains::IndexSettings, parser::connection_parser::build_connection_conf, trace::TracingConfig,
    ChainConf, CoreContractAddresses, Settings, SignerConf,
};

pub use super::envs::*;

pub use self::json_value_parser::ValueParser;

mod connection_parser;
mod json_value_parser;

const DEFAULT_CHUNK_SIZE: u32 = 1999;

/// The base agent config
#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct RawAgentConf(Value);

fn agent_name_to_default_rpc_consensus_type(agent_name: &str) -> String {
    match agent_name {
        "validator" => "quorum".to_string(),
        "relayer" => "fallback".to_string(),
        "scraper" => "fallback".to_string(),
        _ => "fallback".to_string(),
    }
}

impl FromRawConf<RawAgentConf, Option<&HashSet<&str>>> for Settings {
    fn from_config_filtered(
        raw: RawAgentConf,
        cwp: &ConfigPath,
        filter: Option<&HashSet<&str>>,
        agent_name: &str,
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

        let default_rpc_consensus_type = agent_name_to_default_rpc_consensus_type(agent_name);

        let chains: HashMap<String, ChainConf> = raw_chains
            .into_iter()
            .filter_map(|(name, chain)| {
                parse_chain(chain, &name, default_rpc_consensus_type.as_str())
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

    let submitter = chain
        .chain(&mut err)
        .get_opt_key("submitter")
        .parse_from_str::<SubmitterType>("Invalid Submitter type")
        .unwrap_or_default();

    // measured in seconds (with fractions)
    let estimated_block_time = chain
        .chain(&mut err)
        .get_opt_key("blocks")
        .get_key("estimateBlockTime")
        .parse_value("Invalid estimateBlockTime")
        .map(Duration::from_secs_f64)
        .unwrap_or(Duration::from_secs(1));

    let reorg_period = chain
        .chain(&mut err)
        .get_opt_key("blocks")
        .get_key("reorgPeriod")
        .parse_value("Invalid reorgPeriod")
        .unwrap_or(ReorgPeriod::from_blocks(1));

    let rpcs = parse_base_and_override_urls(&chain, "rpcUrls", "customRpcUrls", "http", &mut err);

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
        .unwrap_or(DEFAULT_CHUNK_SIZE);
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
        .get_key("merkleTreeHook")
        .parse_address_hash()
        .end();

    let batch_contract_address = chain
        .chain(&mut err)
        .get_opt_key("batchContractAddress")
        .parse_address_hash()
        .end();

    let max_batch_size = chain
        .chain(&mut err)
        .get_opt_key("maxBatchSize")
        .parse_u32()
        .unwrap_or(1);

    let bypass_batch_simulation = chain
        .chain(&mut err)
        .get_opt_key("bypassBatchSimulation")
        .parse_bool()
        .unwrap_or(false);

    let max_submit_queue_length = chain
        .chain(&mut err)
        .get_opt_key("maxSubmitQueueLength")
        .parse_u32()
        .end();

    let ignore_reorg_reports = chain
        .chain(&mut err)
        .get_opt_key("ignoreReorgReports")
        .parse_bool()
        .unwrap_or(false);

    cfg_unwrap_all!(&chain.cwp, err: [domain]);
    let connection = build_connection_conf(
        domain.domain_protocol(),
        &rpcs,
        &chain,
        &mut err,
        default_rpc_consensus_type,
        OpSubmissionConfig {
            batch_contract_address,
            max_batch_size,
            bypass_batch_simulation,
            max_submit_queue_length,
        },
    );

    cfg_unwrap_all!(&chain.cwp, err: [connection, mailbox, interchain_gas_paymaster, validator_announce, merkle_tree_hook]);
    err.into_result(ChainConf {
        domain,
        signer,
        submitter,
        estimated_block_time,
        reorg_period,
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
        ignore_reorg_reports,
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

    let technical_stack = chain
        .chain(&mut err)
        .get_opt_key("technicalStack")
        .parse_from_str::<HyperlaneDomainTechnicalStack>("Invalid chain technical stack")
        .end()
        .or_else(|| Some(HyperlaneDomainTechnicalStack::default()));

    cfg_unwrap_all!(&chain.cwp, err: [domain_id, protocol, technical_stack]);

    let domain = HyperlaneDomain::from_config(domain_id, name, protocol, technical_stack)
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
        .get_opt_key("type")
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
        (cosmosKey) => {{
            let key = signer
                .chain(&mut err)
                .get_key("key")
                .parse_private_key()
                .unwrap_or_default();
            let prefix = signer
                .chain(&mut err)
                .get_key("prefix")
                .parse_string()
                .unwrap_or_default();
            let account_address_type = signer
                .chain(&mut err)
                .get_opt_key("accountAddressType")
                .parse_from_str("Expected Account Address Type")
                .end()
                .unwrap_or_default();
            err.into_result(SignerConf::CosmosKey {
                key,
                prefix: prefix.to_string(),
                account_address_type,
            })
        }};
    }

    match signer_type {
        Some("hexKey") => parse_signer!(hexKey),
        Some("aws") => parse_signer!(aws),
        Some("cosmosKey") => parse_signer!(cosmosKey),
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
        _agent_name: &str,
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

/// Expects AgentSigner.
fn parse_cosmos_gas_price(gas_price: ValueParser) -> ConfigResult<RawCosmosAmount> {
    let mut err = ConfigParsingError::default();

    let amount = gas_price
        .chain(&mut err)
        .get_opt_key("amount")
        .parse_string()
        .end();

    let denom = gas_price
        .chain(&mut err)
        .get_opt_key("denom")
        .parse_string()
        .end();
    cfg_unwrap_all!(&gas_price.cwp, err: [denom, amount]);
    err.into_result(RawCosmosAmount::new(denom.to_owned(), amount.to_owned()))
}

fn parse_urls(
    chain: &ValueParser,
    key: &str,
    protocol: &str,
    err: &mut ConfigParsingError,
) -> Vec<Url> {
    chain
        .chain(err)
        .get_key(key)
        .into_array_iter()
        .map(|urls| {
            urls.filter_map(|v| {
                v.chain(err)
                    .get_key(protocol)
                    .parse_from_str("Invalid url")
                    .end()
            })
            .collect_vec()
        })
        .unwrap_or_default()
}

fn parse_custom_urls(
    chain: &ValueParser,
    key: &str,
    err: &mut ConfigParsingError,
) -> Option<Vec<Url>> {
    chain
        .chain(err)
        .get_opt_key(key)
        .parse_string()
        .end()
        .map(|urls| {
            urls.split(',')
                .filter_map(|url| url.parse().take_err(err, || &chain.cwp + key))
                .collect_vec()
        })
}

fn parse_base_and_override_urls(
    chain: &ValueParser,
    base_key: &str,
    override_key: &str,
    protocol: &str,
    err: &mut ConfigParsingError,
) -> Vec<Url> {
    let base = parse_urls(chain, base_key, protocol, err);
    let overrides = parse_custom_urls(chain, override_key, err);
    let combined = overrides.unwrap_or(base);

    if combined.is_empty() {
        err.push(
            &chain.cwp + base_key.to_ascii_lowercase(),
            eyre!("Missing base {} definitions for chain", base_key),
        );
        err.push(
            &chain.cwp + override_key.to_lowercase(),
            eyre!("Also missing {} overrides for chain", base_key),
        );
    }
    combined
}

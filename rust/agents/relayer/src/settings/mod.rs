//! Relayer configuration
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, path::PathBuf};

use convert_case::Case;
use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::{eyre, Context};
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{
        parser::{recase_json_value, RawAgentConf, ValueParser},
        Settings,
    },
};
use hyperlane_core::{cfg_unwrap_all, config::*, HyperlaneDomain, U256};
use itertools::Itertools;
use serde::Deserialize;
use serde_json::Value;

use crate::settings::matching_list::MatchingList;

pub mod matching_list;

/// Settings for `Relayer`
#[derive(Debug, AsRef, AsMut, Deref, DerefMut)]
pub struct RelayerSettings {
    #[as_ref]
    #[as_mut]
    #[deref]
    #[deref_mut]
    base: Settings,

    /// Database path
    pub db: PathBuf,
    /// The chain to relay messages from
    pub origin_chains: HashSet<HyperlaneDomain>,
    /// Chains to relay messages to
    pub destination_chains: HashSet<HyperlaneDomain>,
    /// The gas payment enforcement policies
    pub gas_payment_enforcement: Vec<GasPaymentEnforcementConf>,
    /// Filter for what messages to relay.
    pub whitelist: MatchingList,
    /// Filter for what messages to block.
    pub blacklist: MatchingList,
    /// This is optional. If not specified, any amount of gas will be valid, otherwise this
    /// is the max allowed gas in wei to relay a transaction.
    pub transaction_gas_limit: Option<U256>,
    /// List of domain ids to skip transaction gas for.
    pub skip_transaction_gas_limit_for: HashSet<u32>,
    /// If true, allows local storage based checkpoint syncers.
    /// Not intended for production use.
    pub allow_local_checkpoint_syncers: bool,
}

/// Config for gas payment enforcement
#[derive(Debug, Clone, Default)]
pub struct GasPaymentEnforcementConf {
    /// The gas payment enforcement policy
    pub policy: GasPaymentEnforcementPolicy,
    /// An optional matching list, any message that matches will use this
    /// policy. By default all messages will match.
    pub matching_list: MatchingList,
}

/// Config for a GasPaymentEnforcementPolicy
#[derive(Debug, Clone, Default)]
pub enum GasPaymentEnforcementPolicy {
    /// No requirement - all messages are processed regardless of gas payment
    #[default]
    None,
    /// Messages that have paid a minimum amount will be processed
    Minimum { payment: U256 },
    /// The required amount of gas on the foreign chain has been paid according
    /// to on-chain fee quoting.
    OnChainFeeQuoting {
        gas_fraction_numerator: u64,
        gas_fraction_denominator: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawRelayerSettings(Value);

impl_loadable_from_settings!(Relayer, RawRelayerSettings -> RelayerSettings);

impl FromRawConf<RawRelayerSettings> for RelayerSettings {
    fn from_config_filtered(
        raw: RawRelayerSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let p = ValueParser::new(cwp.clone(), &raw.0);

        let relay_chain_names: Option<HashSet<&str>> = p
            .chain(&mut err)
            .get_key("relayChains")
            .parse_string()
            .end()
            .map(|v| v.split(',').collect());

        let base = p
            .parse_from_raw_config::<Settings, RawAgentConf, Option<&HashSet<&str>>>(
                relay_chain_names.as_ref(),
                "Parsing base config",
            )
            .take_config_err(&mut err);

        let db = p
            .chain(&mut err)
            .get_opt_key("db")
            .parse_from_str("Expected database path")
            .unwrap_or_else(|| std::env::current_dir().unwrap().join("hyperlane_db"));

        let (raw_gas_payment_enforcement_path, raw_gas_payment_enforcement) = match p
            .get_opt_key("gasPaymentEnforcement")
            .take_config_err_flat(&mut err)
        {
            None => None,
            Some(ValueParser {
                val: Value::String(policy_str),
                cwp,
            }) => serde_json::from_str::<Value>(policy_str)
                .context("Expected JSON string")
                .take_err(&mut err, || cwp.clone())
                .map(|v| (cwp, recase_json_value(v, Case::Flat))),
            Some(ValueParser {
                val: value @ Value::Array(_),
                cwp,
            }) => Some((cwp, value.clone())),
            Some(_) => Err(eyre!("Expected JSON array or stringified JSON"))
                .take_err(&mut err, || cwp.clone()),
        }
        .unwrap_or_else(|| (&p.cwp + "gas_payment_enforcement", Value::Array(vec![])));

        let gas_payment_enforcement_parser = ValueParser::new(
            raw_gas_payment_enforcement_path,
            &raw_gas_payment_enforcement,
        );
        let gas_payment_enforcement = gas_payment_enforcement_parser.into_array_iter().map(|itr| {
            itr.filter_map(|policy| {
                let policy_type = policy.chain(&mut err).get_opt_key("type").parse_string().end();
                let minimum_is_defined = matches!(policy.get_opt_key("minimum"), Ok(Some(_)));

                let matching_list = policy.chain(&mut err).get_opt_key("matchingList").and_then(parse_matching_list).unwrap_or_default();

                let parse_minimum = |p| GasPaymentEnforcementPolicy::Minimum { payment: p };
                match policy_type {
                    Some("minimum") => policy.chain(&mut err).get_opt_key("payment").parse_u256().end().map(parse_minimum),
                    None if minimum_is_defined => policy.chain(&mut err).get_opt_key("payment").parse_u256().end().map(parse_minimum),
                    Some("none") | None => Some(GasPaymentEnforcementPolicy::None),
                    Some("onChainFeeQuoting") => {
                        let gas_fraction = policy.chain(&mut err)
                            .get_opt_key("gasFraction")
                            .parse_string()
                            .map(|v| v.replace(' ', ""))
                            .unwrap_or_else(|| "1/2".to_owned());
                        let (numerator, denominator) = gas_fraction
                            .split_once('/')
                            .ok_or_else(|| eyre!("Invalid `gas_fraction` for OnChainFeeQuoting gas payment enforcement policy; expected `numerator / denominator`"))
                            .take_err(&mut err, || &policy.cwp + "gas_fraction")
                            .unwrap_or(("1", "1"));

                        Some(GasPaymentEnforcementPolicy::OnChainFeeQuoting {
                            gas_fraction_numerator: numerator
                                .parse()
                                .context("Error parsing gas fraction numerator")
                                .take_err(&mut err, || &policy.cwp + "gas_fraction")
                                .unwrap_or(1),
                            gas_fraction_denominator: denominator
                                .parse()
                                .context("Error parsing gas fraction denominator")
                                .take_err(&mut err, || &policy.cwp + "gas_fraction")
                                .unwrap_or(1),
                        })
                    }
                    Some(pt) => Err(eyre!("Unknown gas payment enforcement policy type `{pt}`"))
                        .take_err(&mut err, || cwp + "type"),
                }.map(|policy| GasPaymentEnforcementConf {
                    policy,
                    matching_list,
                })
            }).collect_vec()
        }).unwrap_or_default();

        let whitelist = p
            .chain(&mut err)
            .get_opt_key("whitelist")
            .and_then(parse_matching_list)
            .unwrap_or_default();
        let blacklist = p
            .chain(&mut err)
            .get_opt_key("blacklist")
            .and_then(parse_matching_list)
            .unwrap_or_default();

        let transaction_gas_limit = p
            .chain(&mut err)
            .get_opt_key("transactionGasLimit")
            .parse_u256()
            .end();

        let skip_transaction_gas_limit_for_names: HashSet<&str> = p
            .chain(&mut err)
            .get_opt_key("skipTransactionGasLimitFor")
            .parse_string()
            .map(|v| v.split(',').collect())
            .unwrap_or_default();

        let allow_local_checkpoint_syncers = p
            .chain(&mut err)
            .get_opt_key("allowLocalCheckpointSyncers")
            .parse_bool()
            .unwrap_or(false);

        cfg_unwrap_all!(cwp, err: [base]);

        let skip_transaction_gas_limit_for = skip_transaction_gas_limit_for_names
            .into_iter()
            .filter_map(|chain| {
                base.lookup_domain(chain)
                    .context("Missing configuration for a chain in `skipTransactionGasLimitFor`")
                    .into_config_result(|| cwp + "skip_transaction_gas_limit_for")
                    .take_config_err(&mut err)
            })
            .map(|d| d.id())
            .collect();

        let relay_chains: HashSet<HyperlaneDomain> = relay_chain_names
            .unwrap_or_default()
            .into_iter()
            .filter_map(|chain| {
                base.lookup_domain(chain)
                    .context("Missing configuration for a chain in `relayChains`")
                    .into_config_result(|| cwp + "relayChains")
                    .take_config_err(&mut err)
            })
            .collect();

        err.into_result(RelayerSettings {
            base,
            db,
            origin_chains: relay_chains.clone(),
            destination_chains: relay_chains,
            gas_payment_enforcement,
            whitelist,
            blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers,
        })
    }
}

fn parse_matching_list(p: ValueParser) -> ConfigResult<MatchingList> {
    let mut err = ConfigParsingError::default();

    let raw_list = match &p {
        ValueParser {
            val: Value::String(matching_list_str),
            cwp,
        } => serde_json::from_str::<Value>(matching_list_str)
            .context("Expected JSON string")
            .take_err(&mut err, || cwp.clone())
            .map(|v| recase_json_value(v, Case::Flat)),
        ValueParser {
            val: value @ Value::Array(_),
            ..
        } => Some((*value).clone()),
        _ => Err(eyre!("Expected JSON array or stringified JSON"))
            .take_err(&mut err, || p.cwp.clone()),
    };
    let Some(raw_list) = raw_list else {
        return err.into_result(MatchingList::default());
    };
    let p = ValueParser::new(p.cwp.clone(), &raw_list);
    let ml = p
        .parse_value::<MatchingList>("Expected matching list")
        .take_config_err(&mut err)
        .unwrap_or_default();

    err.into_result(ml)
}

//! Relayer configuration
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, path::PathBuf};

use convert_case::Case;
use derive_more::{AsMut, AsRef, Deref, DerefMut};
use ethers::utils::hex;
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

use crate::{
    msg::{metadata::IsmCacheConfig, pending_message::DEFAULT_MAX_MESSAGE_RETRIES},
    settings::matching_list::MatchingList,
};

pub mod matching_list;

/// Settings for `Relayer`
#[derive(Debug, AsRef, AsMut, Deref, DerefMut)]
pub struct RelayerSettings {
    #[as_ref]
    #[as_mut]
    #[deref]
    #[deref_mut]
    pub base: Settings,

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
    /// Filter for what addresses to block interactions with.
    /// This is intentionally not an H256 to allow for addresses of any length without
    /// adding any padding.
    pub address_blacklist: Vec<Vec<u8>>,
    /// This is optional. If not specified, any amount of gas will be valid, otherwise this
    /// is the max allowed gas in wei to relay a transaction.
    pub transaction_gas_limit: Option<U256>,
    /// List of domain ids to skip transaction gas for.
    pub skip_transaction_gas_limit_for: HashSet<u32>,
    /// If true, allows local storage based checkpoint syncers.
    /// Not intended for production use.
    pub allow_local_checkpoint_syncers: bool,
    /// App contexts used for metrics.
    pub metric_app_contexts: Vec<(MatchingList, String)>,
    /// Whether to allow contract call caching at all.
    pub allow_contract_call_caching: bool,
    /// The ISM cache policies to use
    pub ism_cache_configs: Vec<IsmCacheConfig>,
    /// Maximum number of retries per operation
    pub max_retries: u32,
    /// Whether to enable indexing of hook events given tx ids from indexed messages.
    pub tx_id_indexing_enabled: bool,
    /// Whether to enable IGP indexing.
    pub igp_indexing_enabled: bool,
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
    /// and regardless of whether a payment for the message was processed by the specified IGP.
    #[default]
    None,
    /// `Minimum` requires a payment to exist on the IGP specified in the config,
    /// even if the payment is zero. For example, a policy of Minimum { payment: 0 }
    /// will only relay messages that send a zero payment to the IGP specified in the config.
    /// This is different from not requiring message senders to make any payment at all to
    /// the configured IGP to get relayed. To relay regardless of the existence of a payment,
    /// the `None` IGP policy should be used.
    Minimum { payment: U256 },
    /// The required amount of gas on the foreign chain has been paid according
    /// to on-chain fee quoting. OnChainFeeQuoting requires a payment to exist
    /// on the IGP specified in the config.
    OnChainFeeQuoting {
        gas_fraction_numerator: u64,
        gas_fraction_denominator: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawRelayerSettings(Value);

impl_loadable_from_settings!(Relayer, RawRelayerSettings -> RelayerSettings);

#[cfg(test)]
mod tests {
    use super::*;
    // use crate::settings::loader::case_adapter::CaseAdapter;
    use hyperlane_base::settings::loader::load_settings;

    #[test]
    fn test_loading_env_and_cli() {
        let result = load_settings::<RawRelayerSettings, RelayerSettings>();
        assert!(result.is_ok());
    }
}

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

        // is_gas_payment_enforcement_set determines if we should be checking for the correct gas payment enforcement policy has been provided with "gasPaymentEnforcement" key
        let (
            raw_gas_payment_enforcement_path,
            raw_gas_payment_enforcement,
            is_gas_payment_enforcement_set,
        ) = {
            match p.get_opt_key("gasPaymentEnforcement") {
                Ok(Some(parser)) => match parse_json_array(parser) {
                    Some((path, value)) => (path, value, true),
                    None => (
                        &p.cwp + "gas_payment_enforcement",
                        Value::Array(vec![]),
                        true,
                    ),
                },
                Ok(None) => (
                    &p.cwp + "gas_payment_enforcement",
                    Value::Array(vec![]),
                    false,
                ),
                Err(_) => (
                    &p.cwp + "gas_payment_enforcement",
                    Value::Array(vec![]),
                    false,
                ),
            }
        };

        let gas_payment_enforcement_parser = ValueParser::new(
            raw_gas_payment_enforcement_path,
            &raw_gas_payment_enforcement,
        );

        if is_gas_payment_enforcement_set
            && gas_payment_enforcement_parser
                .val
                .as_array()
                .unwrap()
                .is_empty()
        {
            Err::<(), eyre::Report>(eyre!("GASPAYMENTENFORCEMENT policy cannot be parsed"))
                .take_err(&mut err, || cwp + "gas_payment_enforcement");
        }

        let mut gas_payment_enforcement = gas_payment_enforcement_parser.into_array_iter().map(|itr| {
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

        if gas_payment_enforcement.is_empty() {
            gas_payment_enforcement.push(GasPaymentEnforcementConf::default());
        }

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

        let address_blacklist = p
            .chain(&mut err)
            .get_opt_key("addressBlacklist")
            .parse_string()
            .end()
            .map(|str| parse_address_list(str, &mut err, || &p.cwp + "address_blacklist"))
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
                    .into_config_result(|| cwp + "relay_chains")
                    .take_config_err(&mut err)
            })
            .collect();

        let (raw_metric_app_contexts_path, raw_metric_app_contexts) = p
            .get_opt_key("metricAppContexts")
            .take_config_err_flat(&mut err)
            .and_then(parse_json_array)
            .unwrap_or_else(|| (&p.cwp + "metric_app_contexts", Value::Array(vec![])));

        let metric_app_contexts_parser =
            ValueParser::new(raw_metric_app_contexts_path, &raw_metric_app_contexts);
        let metric_app_contexts = metric_app_contexts_parser
            .into_array_iter()
            .map(|itr| {
                itr.filter_map(|policy| {
                    let name = policy.chain(&mut err).get_key("name").parse_string().end();

                    let matching_list = policy
                        .chain(&mut err)
                        .get_key("matchingList")
                        .and_then(parse_matching_list)
                        .unwrap_or_default();

                    name.map(|name| (matching_list, name.to_owned()))
                })
                .collect_vec()
            })
            .unwrap_or_default();

        let allow_contract_call_caching = p
            .chain(&mut err)
            .get_opt_key("allowLocalCheckpointSyncers")
            .parse_bool()
            .unwrap_or(true);

        let ism_cache_configs = p
            .chain(&mut err)
            .get_opt_key("ismCacheConfigs")
            .and_then(parse_ism_cache_configs)
            .unwrap_or_default();

        let max_message_retries = p
            .chain(&mut err)
            .get_opt_key("maxMessageRetries")
            .parse_u32()
            .unwrap_or(DEFAULT_MAX_MESSAGE_RETRIES);

        let tx_id_indexing_enabled = p
            .chain(&mut err)
            .get_opt_key("txIdIndexingEnabled")
            .parse_bool()
            .unwrap_or(true);

        let igp_indexing_enabled = p
            .chain(&mut err)
            .get_opt_key("igpIndexingEnabled")
            .parse_bool()
            .unwrap_or(true);

        err.into_result(RelayerSettings {
            base,
            db,
            origin_chains: relay_chains.clone(),
            destination_chains: relay_chains,
            gas_payment_enforcement,
            whitelist,
            blacklist,
            address_blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers,
            metric_app_contexts,
            allow_contract_call_caching,
            ism_cache_configs,
            max_retries: max_message_retries,
            tx_id_indexing_enabled,
            igp_indexing_enabled,
        })
    }
}

fn parse_json_array(p: ValueParser) -> Option<(ConfigPath, Value)> {
    let mut err = ConfigParsingError::default();

    match p {
        ValueParser {
            val: Value::String(array_str),
            cwp,
        } => serde_json::from_str::<Value>(array_str)
            .context("Expected JSON string")
            .take_err(&mut err, || cwp.clone())
            .map(|v| (cwp, recase_json_value(v, Case::Flat))),
        ValueParser {
            val: value @ Value::Array(_),
            cwp,
        } => Some((cwp, value.clone())),
        _ => Err(eyre!("Expected JSON array or stringified JSON"))
            .take_err(&mut err, || p.cwp.clone()),
    }
}

fn parse_matching_list(p: ValueParser) -> ConfigResult<MatchingList> {
    let mut err = ConfigParsingError::default();

    let raw_list = parse_json_array(p.clone()).map(|(_, v)| v);
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

fn parse_ism_cache_configs(p: ValueParser) -> ConfigResult<Vec<IsmCacheConfig>> {
    let mut err = ConfigParsingError::default();

    let raw_list = parse_json_array(p.clone()).map(|(_, v)| v);
    let Some(raw_list) = raw_list else {
        return err.into_result(Default::default());
    };
    let p = ValueParser::new(p.cwp.clone(), &raw_list);
    let ml = p
        .parse_value::<Vec<IsmCacheConfig>>("Expected ISM cache configs")
        .take_config_err(&mut err)
        .unwrap_or_default();

    err.into_result(ml)
}

fn parse_address_list(
    str: &str,
    err: &mut ConfigParsingError,
    err_path: impl Fn() -> ConfigPath,
) -> Vec<Vec<u8>> {
    str.split(',')
        .filter_map(|s| {
            let mut s = s.trim().to_owned();
            if let Some(stripped) = s.strip_prefix("0x") {
                s = stripped.to_owned();
            }
            hex::decode(s).take_err(err, &err_path)
        })
        .collect_vec()
}

#[cfg(test)]
mod test {
    use super::*;
    use hyperlane_core::H160;

    #[test]
    fn test_parse_address_blacklist() {
        let valid_address1 = b"valid".to_vec();
        let valid_address2 = H160::random().as_bytes().to_vec();

        // Successful parsing
        let input = format!(
            "0x{}, {}",
            hex::encode(&valid_address1),
            hex::encode(&valid_address2)
        );
        let mut err = ConfigParsingError::default();
        let res = parse_address_list(&input, &mut err, ConfigPath::default);
        assert_eq!(res, vec![valid_address1.clone(), valid_address2.clone()]);
        assert!(err.is_ok());

        // An error in the final address provided
        let input = format!(
            "0x{}, {}, 0xaazz",
            hex::encode(&valid_address1),
            hex::encode(&valid_address2)
        );
        let mut err = ConfigParsingError::default();
        let res = parse_address_list(&input, &mut err, ConfigPath::default);
        assert_eq!(res, vec![valid_address1, valid_address2]);
        assert!(!err.is_ok());
    }

    #[test]
    fn test_parse_ism_cache_configs() {
        let raw = r#"
        [
            {
                "selector": {
                    "type": "defaultIsm"
                },
                "moduletypes": [2],
                "chains": ["foochain"],
                "cachepolicy": "ismSpecific"
            },
            {
                "selector": {
                    "type": "appContext",
                    "context": "foo"
                },
                "moduletypes": [2],
                "chains": ["foochain"],
                "cachepolicy": "ismSpecific"
            }
        ]
        "#;

        let value = serde_json::from_str::<Value>(raw).unwrap();
        let p = ValueParser::new(ConfigPath::default(), &value);
        let configs = parse_ism_cache_configs(p).unwrap();
        assert_eq!(configs.len(), 2);
    }
}

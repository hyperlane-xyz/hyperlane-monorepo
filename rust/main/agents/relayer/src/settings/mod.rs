//! Relayer configuration
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, ops::Add, path::PathBuf, sync::Arc};

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use ethers::utils::hex;
use eyre::{eyre, Context};
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{
        parser::{parse_json_array, parse_matching_list, RawAgentConf, ValueParser},
        Settings,
    },
};
use hyperlane_core::{cfg_unwrap_all, config::*, HyperlaneDomain, H160, U256};
use itertools::Itertools;
use serde::{Deserialize, Serialize};
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
    pub metric_app_contexts: Arc<Vec<(MatchingList, String)>>,
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
    /// Whether to enable the relay API endpoint (default: false)
    ///
    /// # Deployment requirement
    ///
    /// The relay API feeds an `UnboundedSender` that is shared with the normal
    /// message-processing path. There is no back-pressure at the channel level:
    /// the rate limiter (`relay_api_rate_limit_*`) and `MAX_MESSAGES_PER_TX=10`
    /// provide a soft cap (~17 ops/sec at default limits) but will not prevent
    /// unbounded queue growth under sustained load if the endpoint is exposed
    /// publicly without per-tenant limiting at the ingress layer.
    ///
    /// **The relay API must be deployed behind an ingress that enforces
    /// per-tenant rate limits.** Enabling it on a publicly reachable port
    /// without ingress-level controls risks OOM under a flood of requests.
    pub relay_api_enabled: bool,
    /// Port for the relay API HTTP server. When set, the relay API is served on
    /// this dedicated port instead of the shared metrics port. Defaults to 8900.
    pub relay_api_port: Option<u16>,
    /// Relay API rate limit: max requests per window (default: 100)
    pub relay_api_rate_limit_max_requests: Option<usize>,
    /// Relay API rate limit: time window in seconds (default: 60)
    pub relay_api_rate_limit_window_secs: Option<u64>,
    /// Relay API allowed CORS origins (comma-separated). Defaults to https://nexus.hyperlane.xyz.
    pub relay_api_cors_origins: Vec<String>,
}

/// Config for gas payment enforcement
#[derive(Debug, Clone, Default)]
pub struct GasPaymentEnforcementConf {
    /// The gas payment enforcement policy
    pub policy: GasPaymentEnforcementPolicy,
    /// Origin fee token that must have paid the IGP. The zero address represents native tokens.
    pub fee_token: H160,
    /// An optional matching list, any message that matches will use this
    /// policy. By default all messages will match.
    pub matching_list: MatchingList,
}

/// Config for a GasPaymentEnforcementPolicy
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
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

impl FromRawConf<RawRelayerSettings> for RelayerSettings {
    fn from_config_filtered(
        raw: RawRelayerSettings,
        cwp: &ConfigPath,
        _filter: (),
        agent_name: &str,
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
                agent_name.to_string(),
            )
            .take_config_err(&mut err);

        let current_dir = std::env::current_dir().expect("Failed to get current directory");

        let db = p
            .chain(&mut err)
            .get_opt_key("db")
            .parse_from_str("Expected database path")
            .unwrap_or_else(|| current_dir.join("hyperlane_db"));

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
                        (&p.cwp).add("gas_payment_enforcement"),
                        Value::Array(vec![]),
                        true,
                    ),
                },
                Ok(None) => (
                    (&p.cwp).add("gas_payment_enforcement"),
                    Value::Array(vec![]),
                    false,
                ),
                Err(_) => (
                    (&p.cwp).add("gas_payment_enforcement"),
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
                .map(|v| v.is_empty())
                .unwrap_or(true)
        {
            Err::<(), eyre::Report>(eyre!("GASPAYMENTENFORCEMENT policy cannot be parsed"))
                .take_err(&mut err, || cwp.add("gas_payment_enforcement"));
        }

        let mut gas_payment_enforcement = gas_payment_enforcement_parser.into_array_iter().map(|itr| {
            itr.filter_map(|policy| {
                let policy_type = policy.chain(&mut err).get_opt_key("type").parse_string().end();
                let minimum_is_defined = matches!(policy.get_opt_key("minimum"), Ok(Some(_)));

                let matching_list = policy.chain(&mut err).get_opt_key("matchingList").and_then(parse_matching_list).unwrap_or_default();
                let fee_token = policy.chain(&mut err)
                    .get_opt_key("feeToken")
                    .parse_from_str::<H160>("Expected feeToken to be an EVM address")
                    .end()
                    .unwrap_or_else(H160::zero);

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
                            .take_err(&mut err, || (&policy.cwp).add("gas_fraction"))
                            .unwrap_or(("1", "1"));

                        let gas_fraction_numerator = numerator
                            .parse()
                            .context("Error parsing gas fraction numerator")
                            .take_err(&mut err, || (&policy.cwp).add("gas_fraction"))
                            .unwrap_or(1);
                        let gas_fraction_denominator = denominator
                            .parse()
                            .context("Error parsing gas fraction denominator")
                            .take_err(&mut err, || (&policy.cwp).add("gas_fraction"))
                            .unwrap_or(1);
                        if gas_fraction_denominator == 0 {
                            err.push(
                                (&policy.cwp).add("gas_fraction"),
                                eyre!("gas_fraction denominator cannot be 0"),
                            );
                        }
                        Some(GasPaymentEnforcementPolicy::OnChainFeeQuoting {
                            gas_fraction_numerator,
                            gas_fraction_denominator,
                        })
                    }
                    Some(pt) => Err(eyre!("Unknown gas payment enforcement policy type `{pt}`"))
                        .take_err(&mut err, || cwp.add("type")),
                }.map(|policy| GasPaymentEnforcementConf {
                    policy,
                    fee_token,
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
            .map(|str| parse_address_list(str, &mut err, || (&p.cwp).add("address_blacklist")))
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
                    .into_config_result(|| cwp.add("skip_transaction_gas_limit_for"))
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
                    .into_config_result(|| cwp.add("relay_chains"))
                    .take_config_err(&mut err)
            })
            .collect();

        for gas_payment_policy in &gas_payment_enforcement {
            if gas_payment_policy.fee_token == H160::zero() {
                continue;
            }

            // `relayChains` is the relayer's only chain set. Fee-token policies with wildcard
            // or destination-only matching lists apply to every configured relay chain as a
            // possible origin. Mixed legacy/latest deployments must scope fee-token policies
            // with `matchingList[].origindomain`.
            for domain in &relay_chains {
                if !gas_payment_policy
                    .matching_list
                    .origin_domain_matches(domain.id(), true)
                {
                    continue;
                }

                let chain_setup = match base.chain_setup(domain) {
                    Ok(chain_setup) => chain_setup,
                    Err(e) => {
                        err.push((&p.cwp).add("gas_payment_enforcement"), e);
                        continue;
                    }
                };
                if !chain_setup.addresses.igp_version.supports_fee_tokens() {
                    err.push(
                        (&p.cwp).add("gas_payment_enforcement"),
                        eyre!(
                            "`feeToken` gas payment enforcement requires `{domain}` chain to use a non-legacy IGP"
                        ),
                    );
                }
            }
        }

        let (raw_metric_app_contexts_path, raw_metric_app_contexts) = p
            .get_opt_key("metricAppContexts")
            .take_config_err_flat(&mut err)
            .and_then(parse_json_array)
            .unwrap_or_else(|| ((&p.cwp).add("metric_app_contexts"), Value::Array(vec![])));

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
        let metric_app_contexts: Arc<Vec<(MatchingList, String)>> = Arc::new(metric_app_contexts);

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

        let relay_api_enabled = p
            .chain(&mut err)
            .get_opt_key("relayApiEnabled")
            .parse_bool()
            .unwrap_or(false);

        let relay_api_port = p
            .chain(&mut err)
            .get_opt_key("relayApiPort")
            .parse_u16()
            .end();

        let relay_api_rate_limit_max_requests = p
            .chain(&mut err)
            .get_opt_key("relayApiRateLimitMaxRequests")
            .parse_u32()
            .end()
            .and_then(|v| {
                if v > 0 {
                    Some(v as usize)
                } else {
                    err.push(
                        (&p.cwp).add("relayApiRateLimitMaxRequests"),
                        eyre::eyre!("relayApiRateLimitMaxRequests must be greater than 0"),
                    );
                    None
                }
            });

        let relay_api_rate_limit_window_secs = p
            .chain(&mut err)
            .get_opt_key("relayApiRateLimitWindowSecs")
            .parse_u64()
            .end()
            .and_then(|v| {
                if v > 0 {
                    Some(v)
                } else {
                    err.push(
                        (&p.cwp).add("relayApiRateLimitWindowSecs"),
                        eyre::eyre!("relayApiRateLimitWindowSecs must be greater than 0"),
                    );
                    None
                }
            });

        let relay_api_cors_origins: Vec<String> = p
            .chain(&mut err)
            .get_opt_key("relayApiCorsOrigins")
            .parse_string()
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_else(|| vec!["https://nexus.hyperlane.xyz".to_string()]);

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
            relay_api_enabled,
            relay_api_port,
            relay_api_rate_limit_max_requests,
            relay_api_rate_limit_window_secs,
            relay_api_cors_origins,
        })
    }
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
    use hyperlane_base::settings::IgpVersion;
    use hyperlane_core::H160;
    use serde_json::json;

    fn chain_config(name: &str, domain_id: u32, igp_version: Option<&str>) -> Value {
        let mut chain = json!({
            "name": name,
            "domainid": domain_id,
            "chainid": domain_id,
            "protocol": "ethereum",
            "rpcurls": [{ "http": "http://localhost:8545" }],
            "mailbox": "0x0000000000000000000000000000000000000001",
            "interchaingaspaymaster": "0x0000000000000000000000000000000000000002",
            "validatorannounce": "0x0000000000000000000000000000000000000003",
            "merkletreehook": "0x0000000000000000000000000000000000000004",
        });
        if let Some(version) = igp_version {
            chain
                .as_object_mut()
                .expect("chain config must be an object")
                .insert("igpversion".to_owned(), Value::String(version.to_owned()));
        }
        chain
    }

    fn parse_settings(raw: Value) -> ConfigResult<RelayerSettings> {
        RelayerSettings::from_config_filtered(
            RawRelayerSettings(raw),
            &ConfigPath::default(),
            (),
            "relayer",
        )
    }

    fn assert_fee_token_igp_error(error: ConfigParsingError, chain_name: &str) {
        let error = error.to_string();
        assert!(
            error.contains("non-legacy IGP"),
            "unexpected error: {error}",
        );
        assert!(
            error.contains(chain_name),
            "expected error to name `{chain_name}`: {error}",
        );
    }

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

        let value = serde_json::from_str::<Value>(raw).expect("Failed to parse json");
        let p = ValueParser::new(ConfigPath::default(), &value);
        let configs = parse_ism_cache_configs(p).expect("Failed to parse ism cache config");
        assert_eq!(configs.len(), 2);
    }

    #[test]
    fn fee_token_policy_rejects_missing_igp_version() {
        let settings = parse_settings(json!({
            "relaychains": "legacy",
            "chains": {
                "legacy": chain_config("legacy", 1000, None),
            },
            "gaspaymentenforcement": [{
                "type": "minimum",
                "payment": "1",
                "feetoken": "0x0000000000000000000000000000000000000005",
            }],
        }));

        assert_fee_token_igp_error(
            settings.expect_err("missing IGP version must reject feeToken policy"),
            "legacy",
        );
    }

    #[test]
    fn fee_token_policy_rejects_legacy_igp_version() {
        let settings = parse_settings(json!({
            "relaychains": "legacy",
            "chains": {
                "legacy": chain_config("legacy", 1000, Some("legacy")),
            },
            "gaspaymentenforcement": [{
                "type": "minimum",
                "payment": "1",
                "feetoken": "0x0000000000000000000000000000000000000005",
            }],
        }));

        assert_fee_token_igp_error(
            settings.expect_err("legacy IGP must reject feeToken policy"),
            "legacy",
        );
    }

    #[test]
    fn fee_token_policy_rejects_matching_legacy_origin() {
        let settings = parse_settings(json!({
            "relaychains": "oldorigin,latest",
            "chains": {
                "oldorigin": chain_config("oldorigin", 1000, Some("legacy")),
                "latest": chain_config("latest", 2000, Some("latest")),
            },
            "gaspaymentenforcement": [{
                "type": "minimum",
                "payment": "1",
                "feetoken": "0x0000000000000000000000000000000000000005",
                "matchinglist": [{ "origindomain": 1000 }],
            }],
        }));

        let error = settings
            .expect_err("matched legacy origin must reject feeToken policy")
            .to_string();
        assert!(
            error.contains("non-legacy IGP"),
            "unexpected error: {error}",
        );
        assert!(
            error.contains("oldorigin"),
            "expected error to name rejected origin: {error}",
        );
        assert!(
            !error.contains("latest"),
            "error should not name unmatched latest origin: {error}",
        );
    }

    #[test]
    fn wildcard_fee_token_policy_rejects_each_legacy_relay_chain() {
        let settings = parse_settings(json!({
            "relaychains": "legacy1,legacy2",
            "chains": {
                "legacy1": chain_config("legacy1", 1000, Some("legacy")),
                "legacy2": chain_config("legacy2", 2000, None),
            },
            "gaspaymentenforcement": [{
                "type": "minimum",
                "payment": "1",
                "feetoken": "0x0000000000000000000000000000000000000005",
            }],
        }));

        let error = settings.expect_err("wildcard feeToken policy must reject all legacy origins");
        let error = error.to_string();
        assert!(
            error.contains("legacy1") && error.contains("legacy2"),
            "expected error to name both legacy origins: {error}",
        );
    }

    #[test]
    fn fee_token_policy_allows_explicit_latest_igp_version() {
        let settings = parse_settings(json!({
            "relaychains": "latest",
            "chains": {
                "latest": chain_config("latest", 2000, Some("latest")),
            },
            "gaspaymentenforcement": [{
                "type": "minimum",
                "payment": "1",
                "feetoken": "0x0000000000000000000000000000000000000005",
            }],
        }))
        .expect("latest IGP version should allow feeToken policy");

        let domain = settings
            .base
            .lookup_domain("latest")
            .expect("latest domain should parse");
        let chain_setup = settings
            .base
            .chain_setup(&domain)
            .expect("latest chain should parse");

        assert_eq!(chain_setup.addresses.igp_version, IgpVersion::Latest);
        assert_eq!(
            settings.gas_payment_enforcement[0].fee_token,
            H160::from_low_u64_be(5),
        );
    }

    #[test]
    fn fee_token_policy_ignores_unmatched_legacy_origins() {
        let settings = parse_settings(json!({
            "relaychains": "legacy,latest",
            "chains": {
                "legacy": chain_config("legacy", 1000, Some("legacy")),
                "latest": chain_config("latest", 2000, Some("latest")),
            },
            "gaspaymentenforcement": [{
                "type": "minimum",
                "payment": "1",
                "feetoken": "0x0000000000000000000000000000000000000005",
                "matchinglist": [{ "origindomain": 2000 }],
            }],
        }))
        .expect("unmatched legacy origin should not block feeToken policy");

        assert_eq!(settings.gas_payment_enforcement.len(), 1);
    }

    #[test]
    fn rejects_invalid_igp_version() {
        let settings = parse_settings(json!({
            "relaychains": "chain",
            "chains": {
                "chain": chain_config("chain", 3000, Some("newfangled")),
            },
        }));

        let error = settings.expect_err("invalid IGP version must reject config");
        assert!(
            error.to_string().contains("Invalid IGP version"),
            "unexpected error: {error:?}",
        );
    }
}

//! Relayer configuration
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, path::PathBuf};

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::{eyre, Context};
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{
        deprecated_parser::DeprecatedRawSettings,
        parser::{RawAgentConf, ValueParser},
        Settings,
    },
};
use hyperlane_core::{cfg_unwrap_all, config::*, HyperlaneDomain, U256};
use itertools::Itertools;
use serde::Deserialize;
use serde_json::Value;
use tracing::warn;

use crate::settings::matching_list::MatchingList;

pub mod matching_list;

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
#[serde(tag = "type", rename_all = "camelCase")]
enum RawGasPaymentEnforcementPolicy {
    None,
    Minimum {
        payment: Option<StrOrInt>,
    },
    OnChainFeeQuoting {
        /// Optional fraction of gas which must be paid before attempting to run
        /// the transaction. Must be written as `"numerator /
        /// denominator"` where both are integers.
        #[serde(default = "default_gasfraction")]
        gasfraction: String,
    },
    #[serde(other)]
    Unknown,
}

impl FromRawConf<RawGasPaymentEnforcementPolicy> for GasPaymentEnforcementPolicy {
    fn from_config_filtered(
        raw: RawGasPaymentEnforcementPolicy,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        use RawGasPaymentEnforcementPolicy::*;
        match raw {
            None => Ok(Self::None),
            Minimum { payment } => Ok(Self::Minimum {
                payment: payment
                    .ok_or_else(|| {
                        eyre!("Missing `payment` for Minimum gas payment enforcement policy")
                    })
                    .into_config_result(|| cwp + "payment")?
                    .try_into()
                    .into_config_result(|| cwp + "payment")?,
            }),
            OnChainFeeQuoting { gasfraction } => {
                let (numerator, denominator) =
                    gasfraction
                        .replace(' ', "")
                        .split_once('/')
                        .map(|(a, b)| (a.to_owned(), b.to_owned()))
                        .ok_or_else(|| eyre!("Invalid `gasfraction` for OnChainFeeQuoting gas payment enforcement policy; expected `numerator / denominator`"))
                        .into_config_result(|| cwp + "gasfraction")?;

                Ok(Self::OnChainFeeQuoting {
                    gas_fraction_numerator: numerator
                        .parse()
                        .into_config_result(|| cwp + "gasfraction")?,
                    gas_fraction_denominator: denominator
                        .parse()
                        .into_config_result(|| cwp + "gasfraction")?,
                })
            }
            Unknown => Err(eyre!("Unknown gas payment enforcement policy"))
                .into_config_result(|| cwp.clone()),
        }
    }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGasPaymentEnforcementConf {
    #[serde(flatten)]
    policy: Option<RawGasPaymentEnforcementPolicy>,
    #[serde(default)]
    matching_list: Option<MatchingList>,
}

impl FromRawConf<RawGasPaymentEnforcementConf> for GasPaymentEnforcementConf {
    fn from_config_filtered(
        raw: RawGasPaymentEnforcementConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();
        let policy = raw.policy
            .ok_or_else(|| eyre!("Missing policy for gas payment enforcement config; required if a matching list is provided"))
            .take_err(&mut err, || cwp.clone()).and_then(|r| {
                r.parse_config(cwp).take_config_err(&mut err)
            });

        let matching_list = raw.matching_list.unwrap_or_default();
        err.into_result(Self {
            policy: policy.unwrap(),
            matching_list,
        })
    }
}

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

#[derive(Debug, Deserialize, AsMut)]
#[serde(rename_all = "camelCase")]
pub struct DeprecatedRawRelayerSettings {
    #[serde(flatten)]
    #[as_mut]
    base: DeprecatedRawSettings,
    /// Database path (path on the fs)
    db: Option<String>,
    // Comma separated list of chains to relay between.
    relaychains: Option<String>,
    // Comma separated list of origin chains.
    #[deprecated(note = "Use `relaychains` instead")]
    originchainname: Option<String>,
    // Comma separated list of destination chains.
    #[deprecated(note = "Use `relaychains` instead")]
    destinationchainnames: Option<String>,
    /// The gas payment enforcement configuration as JSON. Expects an ordered array of `GasPaymentEnforcementConfig`.
    gaspaymentenforcement: Option<String>,
    /// This is optional. If no whitelist is provided ALL messages will be considered on the
    /// whitelist.
    whitelist: Option<String>,
    /// This is optional. If no blacklist is provided ALL will be considered to not be on
    /// the blacklist.
    blacklist: Option<String>,
    /// This is optional. If not specified, any amount of gas will be valid, otherwise this
    /// is the max allowed gas in wei to relay a transaction.
    transactiongaslimit: Option<StrOrInt>,
    // TODO: this should be a list of chain names to be consistent
    /// Comma separated List of domain ids to skip applying the transaction gas limit to.
    skiptransactiongaslimitfor: Option<String>,
    /// If true, allows local storage based checkpoint syncers.
    /// Not intended for production use. Defaults to false.
    #[serde(default)]
    allowlocalcheckpointsyncers: bool,
}

impl_loadable_from_settings!(Relayer, DeprecatedRawRelayerSettings -> RelayerSettings);

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawRelayerSettings(Value);

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
                .map(|v| (cwp, v)),
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
                            .unwrap_or_else(|| default_gasfraction().to_owned());
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
            .take_err(&mut err, || cwp.clone()),
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

impl FromRawConf<DeprecatedRawRelayerSettings> for RelayerSettings {
    fn from_config_filtered(
        raw: DeprecatedRawRelayerSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let gas_payment_enforcement = raw
            .gaspaymentenforcement
            .and_then(|j| {
                serde_json::from_str::<Vec<RawGasPaymentEnforcementConf>>(&j)
                    .take_err(&mut err, || cwp + "gaspaymentenforcement")
            })
            .map(|rv| {
                let cwp = cwp + "gaspaymentenforcement";
                rv.into_iter()
                    .enumerate()
                    .filter_map(|(i, r)| {
                        r.parse_config(&cwp.join(i.to_string()))
                            .take_config_err(&mut err)
                    })
                    .collect()
            })
            .unwrap_or_else(|| vec![Default::default()]);

        let whitelist = raw
            .whitelist
            .and_then(|j| {
                serde_json::from_str::<MatchingList>(&j).take_err(&mut err, || cwp + "whitelist")
            })
            .unwrap_or_default();

        let blacklist = raw
            .blacklist
            .and_then(|j| {
                serde_json::from_str::<MatchingList>(&j).take_err(&mut err, || cwp + "blacklist")
            })
            .unwrap_or_default();

        let transaction_gas_limit = raw.transactiongaslimit.and_then(|r| {
            r.try_into()
                .take_err(&mut err, || cwp + "transactiongaslimit")
        });

        let skip_transaction_gas_limit_for = raw
            .skiptransactiongaslimitfor
            .and_then(|r| {
                r.split(',')
                    .map(str::parse)
                    .collect::<Result<_, _>>()
                    .context("Error parsing domain id")
                    .take_err(&mut err, || cwp + "skiptransactiongaslimitfor")
            })
            .unwrap_or_default();

        let mut origin_chain_names = {
            #[allow(deprecated)]
            raw.originchainname
        }
        .map(parse_chains);

        if origin_chain_names.is_some() {
            warn!(
                path = (cwp + "originchainname").json_name(),
                "`originchainname` is deprecated, use `relaychains` instead"
            );
        }

        let mut destination_chain_names = {
            #[allow(deprecated)]
            raw.destinationchainnames
        }
        .map(parse_chains);

        if destination_chain_names.is_some() {
            warn!(
                path = (cwp + "destinationchainnames").json_name(),
                "`destinationchainnames` is deprecated, use `relaychains` instead"
            );
        }

        if let Some(relay_chain_names) = raw.relaychains.map(parse_chains) {
            if origin_chain_names.is_some() {
                err.push(
                    cwp + "originchainname",
                    eyre!("Cannot use `relaychains` and `originchainname` at the same time"),
                );
            }
            if destination_chain_names.is_some() {
                err.push(
                    cwp + "destinationchainnames",
                    eyre!("Cannot use `relaychains` and `destinationchainnames` at the same time"),
                );
            }

            if relay_chain_names.len() < 2 {
                err.push(
                    cwp + "relaychains",
                    eyre!(
                        "The relayer must be configured with at least two chains to relay between"
                    ),
                )
            }
            origin_chain_names = Some(relay_chain_names.clone());
            destination_chain_names = Some(relay_chain_names);
        } else if origin_chain_names.is_none() && destination_chain_names.is_none() {
            err.push(
                cwp + "relaychains",
                eyre!("The relayer must be configured with at least two chains to relay between"),
            );
        } else if origin_chain_names.is_none() {
            err.push(
                cwp + "originchainname",
                eyre!("The relayer must be configured with an origin chain (alternatively use `relaychains`)"),
            );
        } else if destination_chain_names.is_none() {
            err.push(
                cwp + "destinationchainnames",
                eyre!("The relayer must be configured with at least one destination chain (alternatively use `relaychains`)"),
            );
        }

        let db = raw
            .db
            .and_then(|r| r.parse().take_err(&mut err, || cwp + "db"))
            .unwrap_or_else(|| std::env::current_dir().unwrap().join("hyperlane_db"));

        let (Some(origin_chain_names), Some(destination_chain_names)) =
            (origin_chain_names, destination_chain_names)
        else {
            return Err(err);
        };

        let chain_filter = origin_chain_names
            .iter()
            .chain(&destination_chain_names)
            .map(String::as_str)
            .collect();

        let base = raw
            .base
            .parse_config_with_filter::<Settings>(cwp, Some(&chain_filter))
            .take_config_err(&mut err);

        let origin_chains = base
            .as_ref()
            .map(|base| {
                origin_chain_names
                    .iter()
                    .filter_map(|origin| {
                        base.lookup_domain(origin)
                            .context("Missing configuration for an origin chain")
                            .take_err(&mut err, || cwp + "chains" + origin)
                    })
                    .collect()
            })
            .unwrap_or_default();

        // validate all destination chains are present and get their HyperlaneDomain.
        let destination_chains: HashSet<_> = base
            .as_ref()
            .map(|base| {
                destination_chain_names
                    .iter()
                    .filter_map(|destination| {
                        base.lookup_domain(destination)
                            .context("Missing configuration for a destination chain")
                            .take_err(&mut err, || cwp + "chains" + destination)
                    })
                    .collect()
            })
            .unwrap_or_default();

        if let Some(base) = &base {
            for domain in &destination_chains {
                base.chain_setup(domain)
                    .unwrap()
                    .signer
                    .as_ref()
                    .ok_or_else(|| eyre!("Signer is required for destination chains"))
                    .take_err(&mut err, || cwp + "chains" + domain.name() + "signer");
            }
        }

        cfg_unwrap_all!(cwp, err: [base]);
        err.into_result(Self {
            base,
            db,
            origin_chains,
            destination_chains,
            gas_payment_enforcement,
            whitelist,
            blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers: raw.allowlocalcheckpointsyncers,
        })
    }
}

fn default_gasfraction() -> String {
    "1/2".into()
}

fn parse_chains(chains_str: String) -> Vec<String> {
    chains_str.split(',').map(str::to_ascii_lowercase).collect()
}

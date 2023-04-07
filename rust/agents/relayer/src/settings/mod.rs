//! Configuration

use std::path::PathBuf;

use eyre::{eyre, Context};
use serde::Deserialize;

use hyperlane_base::decl_settings;
use hyperlane_core::config::*;
use hyperlane_core::U256;

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
        gasfraction: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

impl FromRawConf<'_, RawGasPaymentEnforcementPolicy> for GasPaymentEnforcementPolicy {
    fn from_config(raw: RawGasPaymentEnforcementPolicy, cwp: &ConfigPath) -> ConfigResult<Self> {
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
                let (numerator, denominator) = gasfraction
                    .ok_or_else(|| eyre!("Missing `gasfraction` for OnChainFeeQuoting gas payment enforcement policy"))
                    .into_config_result(|| cwp + "gasfraction")?
                    .replace(' ', "")
                    .split_once('/')
                    .ok_or_else(|| eyre!("Invalid `gasfraction` for OnChainFeeQuoting gas payment enforcement policy; expected `numerator / denominator`")
                        .into_config_result(|| cwp + "gasfraction"))?;
                let numerator = numerator
                    .strip_suffix(" ")
                    .unwrap_or("")
                    .parse()
                    .into_config_result(|| cwp + "gasfraction")?;
                let denominator = denominator
                    .strip_prefix(" ")
                    .unwrap_or("")
                    .parse()
                    .into_config_result(|| cwp + "gasfraction")?;

                Ok(Self::OnChainFeeQuoting {
                    gas_fraction_numerator: numerator,
                    gas_fraction_denominator: denominator,
                })
            }
            Unknown => Err(eyre!("Unknown gas payment enforcement policy").into_config_err(cwp)),
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
#[serde(tag = "type", rename_all = "camelCase")]
struct RawGasPaymentEnforcementConf {
    #[serde(flatten)]
    policy: GasPaymentEnforcementPolicy,
    #[serde(default)]
    matching_list: Option<MatchingList>,
}

decl_settings!(Relayer,
    Parsed {
        /// Database path (path on the fs)
        db: PathBuf,
        // The name of the origin chain
        origin_chain_name: String,
        // Comma separated list of destination chains.
        destination_chain_names: Vec<String>,
        /// The gas payment enforcement configuration as JSON. Expects an ordered array of `GasPaymentEnforcementConfig`.
        gas_payment_enforcement: Vec<GasPaymentEnforcementConf>,
        /// This is optional. If no whitelist is provided ALL messages will be considered on the
        /// whitelist.
        whitelist: Option<MatchingList>,
        /// This is optional. If no blacklist is provided ALL will be considered to not be on
        /// the blacklist.
        blacklist: Option<MatchingList>,
        /// This is optional. If not specified, any amount of gas will be valid, otherwise this
        /// is the max allowed gas in wei to relay a transaction.
        transaction_gas_limit: Option<U256>,
        /// Comma separated List of domain ids to skip transaction gas for.
        skip_transaction_gas_limit_for: Vec<u32>,
        /// If true, allows local storage based checkpoint syncers.
        /// Not intended for production use. Defaults to false.
        allow_local_checkpoint_syncers: bool,
    },
    Raw {
        db: Option<String>,
        originchainname: Option<String>,
        destinationchainnames: Option<String>,
        gaspaymentenforcement: Option<String>,
        whitelist: Option<String>,
        blacklist: Option<String>,
        transactiongaslimit: Option<StrOrInt>,
        skiptransactiongaslimitfor: Option<String>,
        #[serde(default)]
        allowlocalcheckpointsyncers: bool,
    }
);

impl FromRawConf<'_, RawRelayerSettings> for RelayerSettings {
    fn from_config(raw: RawRelayerSettings, cwp: &ConfigPath) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let base = raw.base.parse_config(&cwp).take_config_err(&mut err);

        let origin_chain_name = raw
            .originchainname
            .ok_or_else(|| eyre!("Missing `originchainname`"))
            .take_err(&mut err, || cwp + "originchainname");

        let destination_chain_names = raw
            .destinationchainnames
            .ok_or_else(|| eyre!("Missing `destinationchainnames`"))
            .take_err(&mut err, || cwp + "destinationchainnames")
            .map(|r| r.split(',').map(|s| s.to_string()).collect());

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
                    .filter_map(|(i, r)| r.parse_config(&cwp.join(i)).take_config_err(&mut err))
                    .collect()
            })
            .unwrap_or_else(|| vec![Default::default()]);

        let whitelist = raw.whitelist.and_then(|j| {
            serde_json::from_str::<MatchingList>(&j).take_err(&mut err, || cwp + "whitelist")
        });

        let blacklist = raw.blacklist.and_then(|j| {
            serde_json::from_str::<MatchingList>(&j).take_err(&mut err, || cwp + "blacklist")
        });

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
                    .take_err(&mut err, || cwp + "skiptransactiongaslimitfor")
            })
            .unwrap_or_default();

        let db = raw
            .db
            .and_then(|r| r.parse().take_err(&mut err, || cwp + "db"))
            .unwrap_or_else(|| {
                std::env::current_dir().unwrap().join(format!(
                    "relayer_db_{}",
                    origin_chain_name.as_deref().unwrap_or("")
                ))
            });

        if err.is_empty() {
            Ok(Self {
                base: base.unwrap(),
                db,
                origin_chain_name: origin_chain_name.unwrap(),
                destination_chain_names: destination_chain_names.unwrap(),
                gas_payment_enforcement,
                whitelist,
                blacklist,
                transaction_gas_limit,
                skip_transaction_gas_limit_for,
                allow_local_checkpoint_syncers: raw.allowlocalcheckpointsyncers,
            })
        } else {
            Err(err)
        }
    }
}

fn default_gasfraction() -> String {
    "1/2".into()
}

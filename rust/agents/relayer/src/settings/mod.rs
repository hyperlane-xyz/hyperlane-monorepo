//! Configuration

use std::collections::HashSet;
use std::path::PathBuf;

use eyre::{eyre, Context};
use serde::Deserialize;
use tracing::warn;

use hyperlane_base::{decl_settings, Settings};
use hyperlane_core::config::*;
use hyperlane_core::{HyperlaneDomain, U256};

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

impl FromRawConf<'_, RawGasPaymentEnforcementPolicy> for GasPaymentEnforcementPolicy {
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

impl FromRawConf<'_, RawGasPaymentEnforcementConf> for GasPaymentEnforcementConf {
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
        err.into_result()?;
        Ok(Self {
            policy: policy.unwrap(),
            matching_list,
        })
    }
}

decl_settings!(Relayer,
    Parsed {
        /// Database path
        db: PathBuf,
        /// The chain to relay messages from
        origin_chains: HashSet<HyperlaneDomain>,
        /// Chains to relay messages to
        destination_chains: HashSet<HyperlaneDomain>,
        /// The gas payment enforcement policies
        gas_payment_enforcement: Vec<GasPaymentEnforcementConf>,
        /// Filter for what messages to relay.
        whitelist: MatchingList,
        /// Filter for what messages to block.
        blacklist: MatchingList,
        /// This is optional. If not specified, any amount of gas will be valid, otherwise this
        /// is the max allowed gas in wei to relay a transaction.
        transaction_gas_limit: Option<U256>,
        /// List of domain ids to skip transaction gas for.
        skip_transaction_gas_limit_for: HashSet<u32>,
        /// If true, allows local storage based checkpoint syncers.
        /// Not intended for production use.
        allow_local_checkpoint_syncers: bool,
    },
    Raw {
        /// Database path (path on the fs)
        db: Option<String>,
        // Comma separated list of origin chains.
        originchainnames: Option<String>,
        #[deprecated(note = "Use `destinationchainnames` instead")]
        originchainname: Option<String>,
        // Comma separated list of destination chains.
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
        /// Comma separated List of domain ids to skip transaction gas for.
        skiptransactiongaslimitfor: Option<String>,
        /// If true, allows local storage based checkpoint syncers.
        /// Not intended for production use. Defaults to false.
        #[serde(default)]
        allowlocalcheckpointsyncers: bool,
    }
);

impl FromRawConf<'_, RawRelayerSettings> for RelayerSettings {
    fn from_config_filtered(
        raw: RawRelayerSettings,
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

        let origin_chain_names = raw
            .originchainnames
            .or_else(|| {
                warn!(
                    path = (cwp + "originchainname").json_name(),
                    "`originchainname` is deprecated, use `originchainnames` instead"
                );
                #[allow(deprecated)]
                raw.originchainname
            })
            .ok_or_else(|| eyre!("Missing `originchainnames`"))
            .take_err(&mut err, || cwp + "originchainnames")
            .map(|s| s.split(',').map(str::to_owned).collect::<Vec<_>>());

        let db = raw
            .db
            .and_then(|r| r.parse().take_err(&mut err, || cwp + "db"))
            .unwrap_or_else(|| std::env::current_dir().unwrap().join("hyperlane_db"));

        let destination_chain_names = raw
            .destinationchainnames
            .ok_or_else(|| eyre!("Missing `destinationchainnames`"))
            .take_err(&mut err, || cwp + "destinationchainnames")
            .map(|r| r.split(',').map(str::to_owned).collect::<Vec<_>>());

        let (Some(origin_chain_names), Some(destination_chain_names)) =
            (origin_chain_names, destination_chain_names)
        else { return Err(err) };

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
            for domain in destination_chains.iter() {
                base.chain_setup(domain)
                    .unwrap()
                    .signer
                    .as_ref()
                    .ok_or_else(|| eyre!("Signer is required for destination chains"))
                    .take_err(&mut err, || cwp + "chains" + domain.name() + "signer");
            }
        }

        err.into_result()?;
        Ok(Self {
            base: base.unwrap(),
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

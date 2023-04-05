//! Configuration

use std::path::PathBuf;

use eyre::Context;
use serde::Deserialize;

use hyperlane_base::{decl_settings, ConfigOptionExt};
use hyperlane_core::utils::StrOrInt;
use hyperlane_core::U256;

use crate::settings::matching_list::MatchingList;

pub mod matching_list;

/// Config for a GasPaymentEnforcementPolicy
#[derive(Debug, Clone)]
pub enum GasPaymentEnforcementPolicy {
    /// No requirement - all messages are processed regardless of gas payment
    None,
    /// Messages that have paid a minimum amount will be processed
    Minimum { payment: U256 },
    /// The required amount of gas on the foreign chain has been paid according
    /// to on-chain fee quoting.
    OnChainFeeQuoting {
        gas_fraction_numerator: U256,
        gas_fraction_denominator: U256,
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

impl TryFrom<RawGasPaymentEnforcementPolicy> for GasPaymentEnforcementPolicy {
    type Error = eyre::Report;

    fn try_from(r: RawGasPaymentEnforcementPolicy) -> Result<Self, Self::Error> {
        Ok(match r {
            RawGasPaymentEnforcementPolicy::None => Self::None,
            RawGasPaymentEnforcementPolicy::Minimum { payment } => Self::Minimum {
                payment: payment
                    .expect_or_eyre("Missing `payment` for Minimum gas payment enforcement policy")?
                    .parse::<U256>()
                    .context(
                        "Invalid `payment` value for Minimum gas payment enforcement policy",
                    )?,
            },
            RawGasPaymentEnforcementPolicy::OnChainFeeQuoting { .. } => {}
            RawGasPaymentEnforcementPolicy::Unknown => {}
        })
    }
}

/// Config for gas payment enforcement
#[derive(Debug, Clone)]
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

impl TryFrom<RawRelayerSettings> for RelayerSettings {
    type Error = eyre::Report;

    fn try_from(r: RawRelayerSettings) -> Result<Self, Self::Error> {
        Ok(Self {
            base: r.base.try_into()?,
            db: r
                .db
                .expect_or_eyre("Missing `db` path")?
                .parse()
                .context("Invalid `db` path")?,
            origin_chain_name: r
                .originchainname
                .expect_or_eyre("Missing `originchainname`")?,
            destination_chain_names: r
                .destinationchainnames
                .expect_or_eyre("Missing `destinationchainnames`")?
                .split(',')
                .map(Into::into)
                .collect(),
            gas_payment_enforcement: {
                let enforcement: Vec<RawGasPaymentEnforcementConf> =
                    serde_json::from_str(r.gaspaymentenforcement.as_deref().unwrap_or("[]"))
                        .context("Invalid `gaspaymentenforcement`")?;
                let parsed: Vec<GasPaymentEnforcementConf> = enforcement
                    .into_iter()
                    .map(|i| i.try_into().context("When parsing `gaspaymentenforcement`"))
                    .collect::<Result<_, _>>()?;
                if !parsed.is_empty() {
                    parsed
                } else {
                    vec![GasPaymentEnforcementConf {
                        policy: GasPaymentEnforcementPolicy::None,
                        matching_list: MatchingList::default(),
                    }]
                }
            },
            whitelist: None,
            blacklist: None,
            transaction_gas_limit: None,
            skip_transaction_gas_limit_for: vec![],
            allow_local_checkpoint_syncers: false,
        })
    }
}

fn default_gasfraction() -> String {
    "1/2".into()
}

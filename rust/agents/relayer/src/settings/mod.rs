//! Configuration

use crate::settings::matching_list::MatchingList;
use hyperlane_base::decl_settings;
use hyperlane_core::U256;

pub mod matching_list;

/// Config for a GasPaymentEnforcementPolicy
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GasPaymentEnforcementPolicy {
    /// No requirement - all messages are processed regardless of gas payment
    None,
    /// Messages that have paid a minimum amount will be processed
    Minimum {
        payment: U256,
    },
    MeetsEstimatedCost,
    /// The required amount of gas on the foreign chain has been paid according
    /// to on-chain fee quoting.
    OnChainFeeQuoting {
        /// Optional fraction of gas which must be paid before attempting to run the transaction.
        /// Must be written as `"numerator / denominator"` where both are integers.
        #[serde(default = "default_gasfraction")]
        gasfraction: String,
    },
}

/// Config for gas payment enforcement
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct GasPaymentEnforcementConfig {
    /// The gas payment enforcement policy
    #[serde(flatten)]
    pub policy: GasPaymentEnforcementPolicy,
    /// An optional matching list, any message that matches will use this policy. By default all
    /// messages will match.
    #[serde(default)]
    pub matching_list: MatchingList,
}

decl_settings!(Relayer {
    /// Database path (path on the fs)
    db: String,
    // The name of the origin chain
    originchainname: String,
    // Comma separated list of destination chains.
    destinationchainnames: String,
    /// The gas payment enforcement configuration as JSON. Expects an ordered array of `GasPaymentEnforcementConfig`.
    gaspaymentenforcement: String,
    /// API key to be used for the `MeetsEstimatedCost` enforcement policy.
    coingeckoapikey: Option<String>,
    /// This is optional. If no whitelist is provided ALL messages will be considered on the
    /// whitelist.
    whitelist: Option<String>,
    /// This is optional. If no blacklist is provided ALL will be considered to not be on
    /// the blacklist.
    blacklist: Option<String>,
    /// This is optional. If not specified, any amount of gas will be valid, otherwise this
    /// is the max allowed gas in wei to relay a transaction.
    transactiongaslimit: Option<String>,
    /// Comma separated List of domain ids to skip transaction gas for.
    skiptransactiongaslimitfor: Option<String>,
});

fn default_gasfraction() -> String {
    "1/2".into()
}

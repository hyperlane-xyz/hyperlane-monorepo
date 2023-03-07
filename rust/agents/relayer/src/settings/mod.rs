//! Configuration

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
    Minimum { payment: U256 },
}

/// Config for gas payment enforcement
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct GasPaymentEnforcementConfig {
    /// The gas payment enforcement policy
    pub policy: GasPaymentEnforcementPolicy,
    /// An optional whitelist, where all matching messages will be considered
    /// as if they have met the gas payment enforcement policy.
    /// If None is provided, all messages will be considered NOT on the whitelist.
    pub whitelist: Option<String>,
}

decl_settings!(Relayer {
    /// Database path (path on the fs)
    db: String,
    // The name of the origin chain
    originchainname: String,
    // Comma separated list of destination chains.
    destinationchainnames: String,
    /// The gas payment enforcement configuration
    gaspaymentenforcement: GasPaymentEnforcementConfig,
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
    /// If true, allows local storage based checkpoint syncers.
    /// Not intended for production use. Defaults to false.
    allowlocalcheckpointsyncers: Option<bool>,
});

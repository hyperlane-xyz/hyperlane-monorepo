//! Configuration

use hyperlane_base::decl_settings;
use hyperlane_core::U256;

pub mod matching_list;

/// Config for a MultisigCheckpointSyncer
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GasPaymentEnforcementPolicy {
    /// No requirement - all messages are processed regardless of gas payment
    None,
    /// Messages that have paid a minimum amount will be processed
    Minimum {
        payment: U256,
    },

    MeetsEstimatedCost {
        coingeckoapikey: Option<String>,
    },
}

decl_settings!(Relayer {
    /// Database path (path on the fs)
    db: String,
    // The name of the origin chain
    originchainname: String,
    // Optional list of destination chains. If none are provided, ALL chains in chain_setup
    // will be used, excluding the origin chain.
    destinationchainnames: Option<String>,
    /// The multisig checkpoint syncer configuration
    multisigcheckpointsyncer: hyperlane_base::MultisigCheckpointSyncerConf,
    /// The gas payment enforcement policy configuration
    gaspaymentenforcementpolicy: GasPaymentEnforcementPolicy,
    /// This is optional. If no whitelist is provided ALL messages will be considered on the
    /// whitelist.
    whitelist: Option<String>,
    /// This is optional. If no blacklist is provided ALL will be considered to not be on
    /// the blacklist.
    blacklist: Option<String>,
    /// This is optional. If not specified, any amount of gas will be valid, otherwise this
    /// is the max allowed gas in wei to relay a transaction.
    transactiongaslimit: Option<String>,
});

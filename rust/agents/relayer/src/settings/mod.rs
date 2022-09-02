//! Configuration

use abacus_base::decl_settings;
use ethers::types::U256;

pub mod matching_list;

/// Config for a MultisigCheckpointSyncer
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GasPaymentEnforcementPolicy {
    /// No requirement - all messages are processed regardless of gas payment
    None,
    /// Messages that have paid a minimum amount will be processed
    Minimum(U256),
}

decl_settings!(Relayer {
    /// The polling interval to check for new signed checkpoints in seconds
    signedcheckpointpollinginterval: String,
    /// The multisig checkpoint syncer configuration
    multisigcheckpointsyncer: abacus_base::MultisigCheckpointSyncerConf,
    /// The gas payment enforcement policy configuration
    gaspaymentenforcement: GasPaymentEnforcementPolicy,
    /// This is optional. If no whitelist is provided ALL messages will be considered on the
    /// whitelist.
    whitelist: Option<String>,
    /// This is optional. If no blacklist is provided ALL will be considered to not be on
    /// the blacklist.
    blacklist: Option<String>,
});

//! Configuration

use abacus_base::decl_settings;

decl_settings!(Relayer {
    /// The polling interval to check for new checkpoints in seconds
    pollinginterval: String,
    /// The maxinmum number of times a processor will try to process a message
    maxretries: String,
    /// The multisig checkpoint syncer configuration
    multisigcheckpointsyncer: abacus_base::MultisigCheckpointSyncerConf,
});

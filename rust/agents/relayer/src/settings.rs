//! Configuration

use abacus_base::decl_settings;

decl_settings!(Relayer {
    /// The polling interval to check for new signed checkpoints in seconds
    signedcheckpointpollinginterval: String,
    /// The maxinmum number of times a processor will try to process a message
    maxprocessingretries: String,
    /// The multisig checkpoint syncer configuration
    multisigcheckpointsyncer: abacus_base::MultisigCheckpointSyncerConf,
});

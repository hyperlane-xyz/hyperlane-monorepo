//! Configuration

use abacus_base::decl_settings;

decl_settings!(Relayer {
    /// The polling interval to check for new checkpoints in seconds
    pollinginterval: String,
    /// The minimum latency in seconds between two relayed checkpoints on the inbox
    submissionlatency: String,
    /// The maxinmum number of times a processor will try to process a message
    maxretries: String,
    /// The checkpoint syncer configuration
    checkpointsyncer: abacus_base::CheckpointSyncerConf,
});

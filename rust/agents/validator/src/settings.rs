//! Configuration

use hyperlane_base::decl_settings;

decl_settings!(Validator {
    // The name of the origin chain
    originchainname: String,
    /// The validator attestation signer
    validator: hyperlane_base::SignerConf,
    /// The checkpoint syncer configuration
    checkpointsyncer: hyperlane_base::CheckpointSyncerConf,
    /// The reorg_period in blocks
    reorgperiod: String,
    /// How frequently to check for new checkpoints
    interval: String,
});

//! Configuration

use abacus_base::decl_settings;

decl_settings!(Checkpointer {
    /// The polling interval (in seconds)
    polling_interval: String,
    /// The minimum period between submitted checkpoints (in seconds)
    creation_latency: String,
});

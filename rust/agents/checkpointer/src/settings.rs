//! Configuration

use abacus_base::decl_settings;

decl_settings!(Checkpointer {
    /// The polling interval (in seconds)
    pollinginterval: String,
    /// The minimum period between submitted checkpoints (in seconds)
    creationlatency: String,
});

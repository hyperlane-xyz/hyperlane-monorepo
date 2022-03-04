//! Configuration

use abacus_base::decl_settings;

decl_settings!(Checkpointer {
    /// The polling interval (in seconds)
    interval: String,
});

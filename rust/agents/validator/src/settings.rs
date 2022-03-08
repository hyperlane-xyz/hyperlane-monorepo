//! Configuration

use abacus_base::decl_settings;

decl_settings!(Validator {
    /// The reorg_period in blocks
    reorg_period: String,
});

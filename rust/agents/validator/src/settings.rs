//! Configuration

use abacus_base::decl_settings;

decl_settings!(Validator {
    /// The validator attestation signer
    validator: abacus_base::SignerConf,
    /// The reorg_period in blocks
    reorgperiod: String,
    /// How frequently to check for new checkpoints
    interval: String,
});

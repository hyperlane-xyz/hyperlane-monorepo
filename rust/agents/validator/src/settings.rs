//! Configuration

use hyperlane_base::{
    decl_settings, CheckpointSyncerConf, EyreOptionExt, RawCheckpointSyncerConf, RawSignerConf,
    SignerConf,
};
use hyperlane_core::utils::StrOrInt;

decl_settings!(Validator,
    Parsed {
        // The name of the origin chain
        origin_chain_name: String,
        /// The validator attestation signer
        validator: SignerConf,
        /// The checkpoint syncer configuration
        checkpoint_syncer: CheckpointSyncerConf,
        /// The reorg_period in blocks
        reorg_period: StrOrInt,
        /// How frequently to check for new checkpoints
        interval: StrOrInt,
    },
    Raw {
        originchainname: Option<String>,
        validator: Option<RawSignerConf>,
        checkpointsyncer: Option<RawCheckpointSyncerConf>,
        reorgperiod: Option<StrOrInt>,
        interval: Option<StrOrInt>,
    },
);

impl TryFrom<RawValidatorSettings> for ValidatorSettings {
    type Error = eyre::Report;

    fn try_from(r: RawValidatorSettings) -> Result<Self, Self::Error> {
        Ok(Self {
            base: r.base.try_into()?,
            origin_chain_name: r
                .originchainname
                .expect_or_eyre("Missing `originchainname`")?,
            validator: r
                .validator
                .expect_or_eyre("Missing `validator`")?
                .try_into()?,
            checkpoint_syncer: r
                .checkpointsyncer
                .expect_or_eyre("Missing `checkpointsyncer`")?
                .try_into()?,
            reorg_period: r.reorgperiod.expect_or_eyre("Missing `reorgperiod`")?,
            interval: r.interval.expect_or_eyre("Missing `interval`")?,
        })
    }
}

//! Configuration

use eyre::eyre;
use hyperlane_base::{
    decl_settings, CheckpointSyncerConf, RawCheckpointSyncerConf, RawSignerConf, SignerConf,
};
use hyperlane_core::config::*;

decl_settings!(Validator,
    Parsed {
        // The name of the origin chain
        origin_chain_name: String,
        /// The validator attestation signer
        validator: SignerConf,
        /// The checkpoint syncer configuration
        checkpoint_syncer: CheckpointSyncerConf,
        /// The reorg_period in blocks
        reorg_period: u32,
        /// How frequently to check for new checkpoints
        interval: u32,
    },
    Raw {
        originchainname: Option<String>,
        validator: Option<RawSignerConf>,
        checkpointsyncer: Option<RawCheckpointSyncerConf>,
        reorgperiod: Option<StrOrInt>,
        interval: Option<StrOrInt>,
    },
);

impl FromRawConf<'_, RawValidatorSettings> for ValidatorSettings {
    fn from_config(raw: RawValidatorSettings, cwp: &ConfigPath) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let base = raw.base.parse_config(&cwp).take_config_err(&mut err);

        let origin_chain_name = raw
            .originchainname
            .expect_or_config_err(|| (cwp + "originchainname", eyre!("Missing `originchainname`")))
            .take_config_err(&mut err);

        let validator = raw
            .validator
            .expect_or_config_err(|| (cwp + "validator", eyre!("Missing `validator`")))
            .take_config_err(&mut err)
            .and_then(|r| {
                r.parse_config(&cwp.join("validator"))
                    .take_config_err(&mut err)
            });

        let checkpoint_syncer = raw
            .checkpointsyncer
            .expect_or_config_err(|| {
                (
                    cwp + "checkpointsyncer",
                    eyre!("Missing `checkpointsyncer`"),
                )
            })
            .take_config_err(&mut err)
            .and_then(|r| {
                r.parse_config(&cwp.join("checkpointsyncer"))
                    .take_config_err(&mut err)
            });

        let reorg_period = raw
            .reorgperiod
            .expect_or_config_err(|| (cwp + "reorgperiod", eyre!("Missing `reorgperiod`")))
            .take_config_err(&mut err)
            .and_then(|r| r.try_into().take_err(&mut err, || cwp + "reorgperiod"));

        let interval = raw
            .interval
            .expect_or_config_err(|| (cwp + "interval", eyre!("Missing `interval`")))
            .take_config_err(&mut err)
            .and_then(|r| r.try_into().take_err(&mut err, || cwp + "interval"));

        if err.is_empty() {
            Ok(Self {
                base: base.unwrap(),
                origin_chain_name: origin_chain_name.unwrap(),
                validator: validator.unwrap(),
                checkpoint_syncer: checkpoint_syncer.unwrap(),
                reorg_period: reorg_period.unwrap(),
                interval: interval.unwrap(),
            })
        } else {
            Err(err)
        }
    }
}

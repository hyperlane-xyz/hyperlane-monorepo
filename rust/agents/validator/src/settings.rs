//! Configuration

use std::time::Duration;

use eyre::eyre;

use hyperlane_base::{
    decl_settings, CheckpointSyncerConf, RawCheckpointSyncerConf, RawSignerConf, Settings,
    SignerConf,
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
        reorg_period: u64,
        /// How frequently to check for new checkpoints
        interval: Duration,
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

        let base = raw
            .base
            .parse_config::<Settings>(cwp)
            .take_config_err(&mut err);

        let origin_chain_name = raw
            .originchainname
            .ok_or_else(|| eyre!("Missing `originchainname`"))
            .take_err(&mut err, || cwp + "originchainname");

        let validator = raw
            .validator
            .ok_or_else(|| eyre!("Missing `validator`"))
            .take_err(&mut err, || cwp + "validator")
            .and_then(|r| {
                r.parse_config(&cwp.join("validator"))
                    .take_config_err(&mut err)
            });

        let checkpoint_syncer = raw
            .checkpointsyncer
            .ok_or_else(|| eyre!("Missing `checkpointsyncer`"))
            .take_err(&mut err, || cwp + "checkpointsyncer")
            .and_then(|r| {
                r.parse_config(&cwp.join("checkpointsyncer"))
                    .take_config_err(&mut err)
            });

        let reorg_period = raw
            .reorgperiod
            .ok_or_else(|| eyre!("Missing `reorgperiod`"))
            .take_err(&mut err, || cwp + "reorgperiod")
            .and_then(|r| r.try_into().take_err(&mut err, || cwp + "reorgperiod"));

        let interval = raw
            .interval
            .ok_or_else(|| eyre!("Missing `interval`"))
            .take_err(&mut err, || cwp + "interval")
            .and_then(|r| {
                r.try_into()
                    .map(Duration::from_secs)
                    .take_err(&mut err, || cwp + "interval")
            });

        if let (Some(base), Some(origin)) = (&base, &origin_chain_name) {
            if !base.chains.contains_key(origin) {
                err.push(
                    cwp + "originchainname",
                    eyre!("Configuration for origin chain '{origin}' not found"),
                )
            }
        }

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

//! Validator configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, path::PathBuf, time::Duration};

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::{eyre, Context};
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{
        deprecated_parser::{
            DeprecatedRawCheckpointSyncerConf, DeprecatedRawSettings, DeprecatedRawSignerConf,
        },
        parser::{RawAgentConf, RawAgentSignerConf, ValueParser},
        CheckpointSyncerConf, Settings, SignerConf,
    },
};
use hyperlane_core::{cfg_unwrap_all, config::*, HyperlaneDomain, HyperlaneDomainProtocol};
use serde::Deserialize;
use serde_json::Value;

/// Settings for `Validator`
#[derive(Debug, AsRef, AsMut, Deref, DerefMut)]
pub struct ValidatorSettings {
    #[as_ref]
    #[as_mut]
    #[deref]
    #[deref_mut]
    base: Settings,

    /// Database path
    pub db: PathBuf,
    /// Chain to validate messages on
    pub origin_chain: HyperlaneDomain,
    /// The validator attestation signer
    pub validator: SignerConf,
    /// The checkpoint syncer configuration
    pub checkpoint_syncer: CheckpointSyncerConf,
    /// The reorg_period in blocks
    pub reorg_period: u64,
    /// How frequently to check for new checkpoints
    pub interval: Duration,
}

/// Raw settings for `Validator`
#[derive(Debug, Deserialize, AsMut)]
#[serde(rename_all = "camelCase")]
pub struct DeprecatedRawValidatorSettings {
    #[serde(flatten, default)]
    #[as_mut]
    base: DeprecatedRawSettings,
    /// Database path (path on the fs)
    db: Option<String>,
    // Name of the chain to validate message on
    originchainname: Option<String>,
    /// The validator attestation signer
    #[serde(default)]
    validator: DeprecatedRawSignerConf,
    /// The checkpoint syncer configuration
    checkpointsyncer: Option<DeprecatedRawCheckpointSyncerConf>,
    /// The reorg_period in blocks
    reorgperiod: Option<StrOrInt>,
    /// How frequently to check for new checkpoints
    interval: Option<StrOrInt>,
}

impl_loadable_from_settings!(Validator, DeprecatedRawValidatorSettings -> ValidatorSettings);

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawValidatorSettings(Value);

impl FromRawConf<RawValidatorSettings> for ValidatorSettings {
    fn from_config_filtered(
        raw: RawValidatorSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let p = ValueParser::new(cwp.clone(), &raw.0);

        let origin_chain_name = p
            .chain(&mut err)
            .get_key("originChainName")
            .parse_string()
            .end();

        let origin_chain_name_set = origin_chain_name.map(|s| HashSet::from([s]));
        let base = p
            .parse_from_raw_config::<Settings, RawAgentConf, Option<&HashSet<&str>>>(
                origin_chain_name_set.as_ref(),
                "Expected valid base agent configuration",
            )
            .take_config_err(&mut err);

        let origin_chain = if let (Some(base), Some(origin_chain_name)) = (&base, origin_chain_name)
        {
            base.lookup_domain(origin_chain_name)
                .context("Missing configuration for the origin chain")
                .take_err(&mut err, || cwp + "origin_chain_name")
        } else {
            None
        };

        let validator = p
            .chain(&mut err)
            .get_key("validator")
            .parse_from_raw_config::<SignerConf, RawAgentSignerConf, NoFilter>(
                (),
                "Expected valid validator configuration",
            )
            .end();

        let db = p
            .chain(&mut err)
            .get_opt_key("db")
            .parse_from_str("Expected db file path")
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap()
                    .join(format!("validator_db_{}", origin_chain_name.unwrap_or("")))
            });

        let checkpoint_syncer = p
            .chain(&mut err)
            .get_key("checkpointSyncer")
            .and_then(parse_checkpoint_syncer)
            .end();

        let interval = p
            .chain(&mut err)
            .get_opt_key("interval")
            .parse_u64()
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(5));

        cfg_unwrap_all!(cwp, err: [origin_chain_name]);

        let reorg_period = p
            .chain(&mut err)
            .get_key("chains")
            .get_key(origin_chain_name)
            .get_opt_key("blocks")
            .get_opt_key("reorgPeriod")
            .parse_u64()
            .unwrap_or(1);

        cfg_unwrap_all!(cwp, err: [base, origin_chain, validator, checkpoint_syncer]);

        err.into_result(Self {
            base,
            db,
            origin_chain,
            validator,
            checkpoint_syncer,
            reorg_period,
            interval,
        })
    }
}

/// Expects ValidatorAgentConfig.checkpointSyncer
fn parse_checkpoint_syncer(syncer: ValueParser) -> ConfigResult<CheckpointSyncerConf> {
    let mut err = ConfigParsingError::default();
    let syncer_type = syncer.chain(&mut err).get_key("type").parse_string().end();

    match syncer_type {
        Some("localStorage") => {
            let path = syncer
                .chain(&mut err)
                .get_key("path")
                .parse_from_str("Expected checkpoint syncer file path")
                .end();
            cfg_unwrap_all!(&syncer.cwp, err: [path]);
            err.into_result(CheckpointSyncerConf::LocalStorage { path })
        }
        Some("s3") => {
            let bucket = syncer
                .chain(&mut err)
                .get_key("bucket")
                .parse_string()
                .end()
                .map(str::to_owned);
            let region = syncer
                .chain(&mut err)
                .get_key("region")
                .parse_from_str("Expected aws region")
                .end();
            let folder = syncer
                .chain(&mut err)
                .get_opt_key("folder")
                .parse_string()
                .end()
                .map(str::to_owned);

            cfg_unwrap_all!(&syncer.cwp, err: [bucket, region]);
            err.into_result(CheckpointSyncerConf::S3 {
                bucket,
                region,
                folder,
            })
        }
        Some(_) => {
            Err(eyre!("Unknown checkpoint syncer type")).into_config_result(|| &syncer.cwp + "type")
        }
        None => Err(err),
    }
}

impl FromRawConf<DeprecatedRawValidatorSettings> for ValidatorSettings {
    fn from_config_filtered(
        raw: DeprecatedRawValidatorSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let validator = raw
            .validator
            .parse_config::<SignerConf>(&cwp.join("validator"))
            .take_config_err(&mut err);

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
            .and_then(|r| {
                r.try_into()
                    .map(Duration::from_secs)
                    .take_err(&mut err, || cwp + "interval")
            })
            .unwrap_or(Duration::from_secs(5));

        let Some(origin_chain_name) = raw
            .originchainname
            .ok_or_else(|| eyre!("Missing `originchainname`"))
            .take_err(&mut err, || cwp + "originchainname")
            .map(|s| s.to_ascii_lowercase())
        else {
            return Err(err);
        };

        let db = raw
            .db
            .and_then(|r| r.parse().take_err(&mut err, || cwp + "db"))
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap()
                    .join(format!("validator_db_{origin_chain_name}"))
            });

        let base = raw
            .base
            .parse_config_with_filter::<Settings>(
                cwp,
                Some(&[origin_chain_name.as_ref()].into_iter().collect()),
            )
            .take_config_err(&mut err);

        let origin_chain = base.as_ref().and_then(|base| {
            base.lookup_domain(&origin_chain_name)
                .context("Missing configuration for the origin chain")
                .take_err(&mut err, || cwp + "chains" + &origin_chain_name)
        });

        cfg_unwrap_all!(cwp, err: [base, origin_chain, validator, checkpoint_syncer, reorg_period]);
        let mut base = base;

        if origin_chain.domain_protocol() == HyperlaneDomainProtocol::Ethereum {
            // if an EVM chain we can assume the chain signer is the validator signer when not
            // specified
            if let Some(chain) = base.chains.get_mut(origin_chain.name()) {
                chain.signer.get_or_insert_with(|| validator.clone());
            }
        }

        err.into_result(Self {
            base,
            db,
            origin_chain,
            validator,
            checkpoint_syncer,
            reorg_period,
            interval,
        })
    }
}

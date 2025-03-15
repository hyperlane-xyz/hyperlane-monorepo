//! Validator configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, path::PathBuf, time::Duration};

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::{eyre, Context};
use hyperlane_base::{
    impl_loadable_from_settings,
    settings::{
        parser::{RawAgentConf, RawAgentSignerConf, ValueParser},
        CheckpointSyncerConf, Settings, SignerConf,
    },
};
use hyperlane_core::{
    cfg_unwrap_all, config::*, HyperlaneDomain, HyperlaneDomainProtocol, ReorgPeriod,
};
use serde::Deserialize;
use serde_json::Value;

/// Settings for `Validator`
#[derive(Clone, Debug, AsRef, AsMut, Deref, DerefMut)]
pub struct ValidatorSettings {
    #[as_ref]
    #[as_mut]
    #[deref]
    #[deref_mut]
    base: Settings,
    pub validators: Vec<ChainValidatorSettings>,
}

#[derive(Clone, Debug, AsRef, AsMut, Deref, DerefMut)]
pub struct ChainValidatorSettings {
    #[as_ref]
    #[as_mut]
    #[deref]
    #[deref_mut]

    /// Database path
    pub db: PathBuf,
    /// Chain to validate messages on
    pub origin_chain: HyperlaneDomain,
    /// The validator attestation signer
    pub validator: SignerConf,
    /// The checkpoint syncer configuration
    pub checkpoint_syncer: CheckpointSyncerConf,
    /// The reorg configuration
    pub reorg_period: ReorgPeriod,
    /// How frequently to check for new checkpoints
    pub interval: Duration,
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawValidatorSettings(Value);

impl_loadable_from_settings!(Validator, RawValidatorSettings -> ValidatorSettings);

impl FromRawConf<RawValidatorSettings> for ValidatorSettings {
    fn from_config_filtered(
        raw: RawValidatorSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let p = ValueParser::new(cwp.clone(), &raw.0);

        // Parse the base config
        // NOTE: Hyperlane mainline filters to a specific origin chain on their mainline repo,
        // but since this fork supports multiple origin chains, we pass None as the filter.
        let base: Option<Settings> = p
            .parse_from_raw_config::<Settings, RawAgentConf, Option<&HashSet<&str>>>(
                None,
                "Expected valid base agent configuration",
            )
            .take_config_err(&mut err);

        let validator = p
            .chain(&mut err)
            .get_key("validator")
            .parse_from_raw_config::<SignerConf, RawAgentSignerConf, NoFilter>(
                (),
                "Expected valid validator configuration",
            )
            .end();

        // Parse root db path
        // When creating validator configs, a /<chain> will be automatically appended
        let db_root_path = p.chain(&mut err).get_key("db").parse_string().end();

        let checkpoint_syncer = p
            .chain(&mut err)
            .get_key("checkpointSyncer")
            .and_then(parse_checkpoint_syncer)
            .end();

        // Do not set interval, it is automatically computed.
        let interval = p
            .chain(&mut err)
            .get_opt_key("interval")
            .parse_u64()
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(5));

        // Get active chains
        let origin_chain_names = p
            .chain(&mut err)
            .get_key("originchainnames")
            .into_array_iter()
            .map(|items| {
                let parsed = items.map(|v| {
                    let origin_chain = v.chain(&mut err).parse_string().end().unwrap();

                    origin_chain.to_owned()
                });
                let collected = parsed.collect::<Vec<String>>();

                collected
            })
            .unwrap();

        cfg_unwrap_all!(cwp, err: [base, validator, checkpoint_syncer, db_root_path]);

        // Build a validator config for each validator
        let mut validators: Vec<ChainValidatorSettings> = vec![];
        for origin_chain_name in origin_chain_names {
            let validator: Result<ChainValidatorSettings, ConfigParsingError> = parse_validator(
                &base,
                cwp,
                db_root_path,
                checkpoint_syncer.clone(),
                validator.clone(),
                origin_chain_name.as_str(),
                interval,
            );
            validators.push(validator.unwrap());
        }

        err.into_result(Self {
            base: base,
            validators,
        })
    }
}

fn parse_validator(
    base: &Settings,
    cwp: &ConfigPath,
    db_root_path: &str,
    mut checkpoint_syncer: CheckpointSyncerConf,
    validator: SignerConf,
    origin_chain_name: &str,
    interval: Duration,
) -> Result<ChainValidatorSettings, ConfigParsingError> {
    let mut err: ConfigParsingError = ConfigParsingError::default();
    let origin_chain = base
        .lookup_domain(origin_chain_name)
        .context("Missing configuration for the origin chain")
        .take_err(&mut err, || cwp + "origin_chain_name");

    cfg_unwrap_all!(cwp, err: [origin_chain]);

    // Automatically append the origin chain name to both the db path and the s3 checkpoint syncer
    let subfolder = format!("{}", origin_chain_name);
    let db_path = format!("{}/{}", db_root_path, subfolder);

    if let CheckpointSyncerConf::S3 { folder, .. } = &mut checkpoint_syncer {
        match folder {
            Some(ref mut existing_folder) => existing_folder.push_str(&subfolder),
            None => *folder = Some(subfolder),
        }
    }

    // Automatically set interval to be one block
    let chain_config = base.chains.get(origin_chain_name);
    cfg_unwrap_all!(cwp, err: [chain_config]);

    // Get chain config, which is needed to find the reorg period
    let reorg_period = chain_config.reorg_period.clone();

    err.into_result(ChainValidatorSettings {
        db: db_path.into(),
        origin_chain,
        validator,
        checkpoint_syncer,
        reorg_period,
        interval,
    })
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
        Some("gcs") => {
            let bucket = syncer
                .chain(&mut err)
                .get_key("bucket")
                .parse_string()
                .end()
                .map(str::to_owned);
            let folder = syncer
                .chain(&mut err)
                .get_opt_key("folder")
                .parse_string()
                .end()
                .map(str::to_owned);
            let service_account_key = syncer
                .chain(&mut err)
                .get_opt_key("service_account_key")
                .parse_string()
                .end()
                .map(str::to_owned);
            let user_secrets = syncer
                .chain(&mut err)
                .get_opt_key("user_secrets")
                .parse_string()
                .end()
                .map(str::to_owned);

            cfg_unwrap_all!(&syncer.cwp, err: [bucket]);
            err.into_result(CheckpointSyncerConf::Gcs {
                bucket,
                folder,
                service_account_key,
                user_secrets,
            })
        }
        Some(_) => {
            Err(eyre!("Unknown checkpoint syncer type")).into_config_result(|| &syncer.cwp + "type")
        }
        None => Err(err),
    }
}

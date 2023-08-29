//! Validator configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, path::PathBuf, time::Duration};

use derive_more::{AsMut, AsRef, Deref, DerefMut};
use eyre::{eyre, Context};
use hyperlane_base::{
    impl_loadable_from_settings, parse,
    settings::{
        parser::{RawAgentConf, RawAgentSignerConf, ValueParser},
        CheckpointSyncerConf, Settings, SignerConf,
    },
};
use hyperlane_core::{cfg_unwrap_all, config::*, HyperlaneDomain};
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

        let origin_chain_name = parse! {
            p(err)
            |> get_key("originChainName")?
            |> parse_string()?
        };

        let origin_chain_name_set = origin_chain_name.map(|s| HashSet::from([s]));
        let base = parse! {
            p(err)
            |> parse_from_raw_config::<Settings, RawAgentConf, Option<&HashSet<&str>>>(
                origin_chain_name_set.as_ref(),
                "Expected valid base agent configuration"
            )?
        };

        let origin_chain = if let (Some(base), Some(origin_chain_name)) = (&base, origin_chain_name)
        {
            base.lookup_domain(origin_chain_name)
                .context("Missing configuration for the origin chain")
                .take_err(&mut err, || cwp + "origin_chain_name")
        } else {
            None
        };

        let validator = parse! {
            p(err)
            |> get_key("validator")?
            |> parse_from_raw_config::<SignerConf, RawAgentSignerConf, NoFilter>(
                (),
                "Expected valid validator configuration"
            )?
        };

        let db = parse! {
            p(err)
            |> get_opt_key("db")??
            |> parse_from_str("Expected db file path")?
            || std::env::current_dir()
                .unwrap()
                .join(format!("validator_db_{}", origin_chain_name.unwrap_or("")))
        };

        let checkpoint_syncer = parse! {
            p(err)
            |> get_key("checkpointSyncer")?
            @> parse_checkpoint_syncer()?
        };

        let from_secs = Duration::from_secs;
        let interval = parse! {
            p(err)
            |> get_opt_key("interval")??
            |> parse_u64()?
            @> from_secs()
            || Duration::from_secs(5)
        };

        cfg_unwrap_all!(cwp, err: [origin_chain_name]);

        let reorg_period = parse! {
            p(err)
            |> get_key("chains")?
            |> get_key(origin_chain_name)?
            |> get_opt_key("blocks")??
            |> get_opt_key("reorgPeriod")??
            |> parse_u64()?
            || 1
        };

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
    let syncer_type = parse! {
        syncer(err)
        |> get_key("type")?
        |> parse_string()?
    };

    match syncer_type {
        Some("localStorage") => {
            let path = parse! {
                syncer(err)
                |> get_key("path")?
                |> parse_from_str("Expected checkpoint syncer file path")?
            };
            cfg_unwrap_all!(&syncer.cwp, err: [path]);
            err.into_result(CheckpointSyncerConf::LocalStorage { path })
        }
        Some("s3") => {
            let bucket = parse! {
                syncer(err)
                |> get_key("bucket")?
                |> parse_string()?
                |> to_owned()
            };
            let region = parse! {
                syncer(err)
                |> get_key("region")?
                |> parse_from_str("Expected aws region")?
            };
            let folder = parse! {
                syncer(err)
                |> get_opt_key("folder")??
                |> parse_string()?
                |> to_owned()
            };
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

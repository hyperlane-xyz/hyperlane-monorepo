//! Validator configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, path::PathBuf, time::Duration};

use aws_config::Region;
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
use itertools::Itertools;
use serde::Deserialize;
use serde_json::Value;

/// Settings for RPCs
#[derive(Debug)]
pub struct RpcConfig {
    pub url: String,
    pub public: bool,
}

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
    /// The reorg configuration
    pub reorg_period: ReorgPeriod,
    /// How frequently to check for new checkpoints
    pub interval: Duration,
    /// A list of RPCs that the validator uses
    pub rpcs: Vec<RpcConfig>,
    /// If the validator oped into public RPCs
    pub allow_public_rpcs: bool,
    /// Max sign concurrency
    pub max_sign_concurrency: usize,
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

        let origin_chain_name = p
            .chain(&mut err)
            .get_key("originChainName")
            .parse_string()
            .end();

        let allow_public_rpcs = p
            .chain(&mut err)
            .get_opt_key("allowPublicRpcs")
            .parse_bool()
            .unwrap_or(false);

        let origin_chain_name_set = origin_chain_name.map(|s| HashSet::from([s]));

        let base: Option<Settings> = p
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
            .parse_value("Invalid reorgPeriod")
            .unwrap_or(ReorgPeriod::from_blocks(1));

        let chain = p
            .chain(&mut err)
            .get_key("chains")
            .get_key(origin_chain_name)
            .end()
            .unwrap();

        let max_sign_concurrency = p
            .chain(&mut err)
            .get_opt_key("maxSignConcurrency")
            .parse_u64()
            .unwrap_or(50) as usize;

        let mut rpcs = get_rpc_urls(&chain, "rpcUrls", "customRpcUrls", &mut err);
        // this is only relevant for cosmos
        rpcs.extend(get_rpc_urls(&chain, "grpcUrls", "customGrpcUrls", &mut err));

        cfg_unwrap_all!(cwp, err: [base, origin_chain, validator, checkpoint_syncer]);

        let mut base: Settings = base;
        // If the origin chain is an EVM chain, then we can use the validator as the signer if needed.
        if origin_chain.domain_protocol() == HyperlaneDomainProtocol::Ethereum {
            if let Some(origin) = base.chains.get_mut(origin_chain.name()) {
                origin.signer.get_or_insert_with(|| validator.clone());
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
            rpcs,
            allow_public_rpcs,
            max_sign_concurrency,
        })
    }
}

/// Extracts all of the rpc urls
///
/// rpcKey is either grpcUrls or rpcUrls
/// overrideKey is either customGrpcUrls or customRpcUrls
fn get_rpc_urls(
    chain: &ValueParser,
    rpc_key: &str,
    override_key: &str,
    err: &mut ConfigParsingError,
) -> Vec<RpcConfig> {
    // struct looks like the following
    // ```rust
    // {
    //   rpc: [
    //     {
    //       "http": "http://my-rpc-url.com",
    //       "public": true
    //     }
    //   ]
    // }
    // ```
    let base = chain
        .chain(err)
        .get_opt_key(rpc_key)
        .into_array_iter()
        .map(|urls| {
            urls.filter_map(|v| {
                let public = v
                    .chain(err)
                    .get_opt_key("public")
                    .parse_bool()
                    .unwrap_or(false);
                let url: Option<&str> = v.chain(err).get_key("http").parse_string().end();
                url.map(|url| RpcConfig {
                    url: url.to_owned(),
                    public,
                })
            })
            .collect_vec()
        })
        .unwrap_or_default();
    let overrides = chain
        .chain(err)
        .get_opt_key(override_key)
        .parse_string()
        .end()
        .map(|urls| {
            urls.split(',')
                .map(|url| RpcConfig {
                    url: url.to_owned(),
                    public: false,
                })
                .collect_vec()
        });
    overrides.unwrap_or(base)
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
            // Using rusoto_core::Region just to get some input validation
            let region: Option<rusoto_core::Region> = syncer
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
                region: Region::new(region.name().to_owned()),
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

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_get_rpc_urls_explicit() {
        let expected = [
            RpcConfig {
                url: "http://my-rpc-url.com".to_string(),
                public: true,
            },
            RpcConfig {
                url: "http://my-rpc-url-2.com".to_string(),
                public: false,
            },
        ];

        let rpcs = expected
            .iter()
            .map(|rpc| {
                serde_json::json!({
                    "http": rpc.url,
                    "public": rpc.public
                })
            })
            .collect::<Vec<_>>();
        let rpcs = serde_json::json!({
            "rpcurls": rpcs
        });

        let mut err = ConfigParsingError::default();
        let value_parser = ValueParser::new(ConfigPath::default(), &rpcs);
        let parsed = get_rpc_urls(&value_parser, "rpcUrls", "customRpcUrls", &mut err); // why does it convert to lowercase?

        assert_eq!(parsed.len(), expected.len());
        for (i, rpc) in expected.iter().enumerate() {
            assert_eq!(parsed[i].url, rpc.url);
            assert_eq!(parsed[i].public, rpc.public);
        }
    }

    #[test]
    fn test_get_rpc_urls_implicit_private() {
        let rpcs = r#"
            {
                "rpcurls": [
                    {
                        "http": "http://my-rpc-url.com"
                    },
                    {
                        "http": "http://my-rpc-url-2.com",
                        "public": false
                    }
                ]
            }
        "#;
        let rpcs = serde_json::from_str(rpcs).unwrap();
        let mut err = ConfigParsingError::default();
        let value_parser = ValueParser::new(ConfigPath::default(), &rpcs);
        let parsed = get_rpc_urls(&value_parser, "rpcUrls", "customRpcUrls", &mut err);

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].url, "http://my-rpc-url.com");
        assert!(!parsed[0].public);
        assert_eq!(parsed[1].url, "http://my-rpc-url-2.com");
        assert!(!parsed[1].public);
    }

    #[test]
    fn test_get_rpc_urls_overrides() {
        let rpcs = r#"
            {
                "rpcurls": [
                    {
                        "http": "http://my-rpc-url.com"
                    },
                    {
                        "http": "http://my-rpc-url-2.com",
                        "public": false
                    }
                ],
                "customrpcurls": "http://my-rpc-url-3.com,http://my-rpc-url-4.com"
            }
        "#;
        let rpcs = serde_json::from_str(rpcs).unwrap();
        let mut err = ConfigParsingError::default();
        let value_parser = ValueParser::new(ConfigPath::default(), &rpcs);
        let parsed = get_rpc_urls(&value_parser, "rpcUrls", "customRpcUrls", &mut err);

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].url, "http://my-rpc-url-3.com");
        assert!(!parsed[0].public);
        assert_eq!(parsed[1].url, "http://my-rpc-url-4.com");
        assert!(!parsed[1].public);
    }
}

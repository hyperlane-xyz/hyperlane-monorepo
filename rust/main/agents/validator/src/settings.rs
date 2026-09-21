//! Validator configuration.
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{collections::HashSet, ops::Add, path::PathBuf, time::Duration};

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

const DEFAULT_MAX_SIGN_CONCURRENCY: usize = 50;
// Bounds per-batch allocation and in-flight signing work while leaving ample
// headroom above the operational default. Keep in sync with the SDK schema.
const MAX_SIGN_CONCURRENCY: usize = 1_000;

/// Settings for RPCs
#[derive(Debug, Clone)]
pub struct RpcConfig {
    pub url: String,
    pub public: bool,
}

/// Settings for `Validator`
#[derive(Debug, AsRef, AsMut, Deref, DerefMut, Clone)]
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
    /// How frequently to check for new checkpoints. Defaults to 2s, overridable
    /// via `interval`, or via `chains.<originChainName>.index.interval` if
    /// `interval` is unset.
    pub interval: Duration,
    /// Merkle tree insertion source for replay and live events. Leaves are verified
    /// against on-chain checkpoints before signing, without per-leaf RPC log reads.
    /// Outside lightweight mode, RPC indexing is used on stream failure or checkpoint mismatch.
    pub websocket_url: Option<url::Url>,
    /// Websocket indexing; two thirds of state-read endpoints must authenticate the signed history.
    /// Disables all RPC log indexing and batch recovery. `leightweigt` is an alias.
    pub lightweight: bool,
    /// A list of RPCs that the validator uses
    pub rpcs: Vec<RpcConfig>,
    /// If the validator oped into public RPCs
    pub allow_public_rpcs: bool,
    /// Test-only: skips on-chain self-announce. Never use in production.
    pub skip_announce: bool,
    /// Max sign concurrency
    pub max_sign_concurrency: usize,
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
struct RawValidatorSettings(Value);

impl_loadable_from_settings!(Validator, RawValidatorSettings -> ValidatorSettings);

impl FromRawConf<RawValidatorSettings> for ValidatorSettings {
    fn from_config_filtered(
        mut raw: RawValidatorSettings,
        cwp: &ConfigPath,
        _filter: (),
        agent_name: &str,
    ) -> ConfigResult<Self> {
        let lightweight = parse_lightweight_flag(&mut raw.0, cwp)?;
        let curr_dir = std::env::current_dir().map_err(|err| {
            let mut config_err = ConfigParsingError::default();
            config_err.push(cwp.clone(), eyre::eyre!(err.to_string()));
            config_err
        })?;

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
            .unwrap_or(false)
            || lightweight;

        let skip_announce = p
            .chain(&mut err)
            .get_opt_key("skipAnnounce")
            .parse_bool()
            .unwrap_or(false);

        let origin_chain_name_set = origin_chain_name.map(|s| HashSet::from([s]));

        let base: Option<Settings> = p
            .parse_from_raw_config::<Settings, RawAgentConf, Option<&HashSet<&str>>>(
                origin_chain_name_set.as_ref(),
                "Expected valid base agent configuration",
                agent_name.to_string(),
            )
            .take_config_err(&mut err);

        let origin_chain = if let (Some(base), Some(origin_chain_name)) = (&base, origin_chain_name)
        {
            base.lookup_domain(origin_chain_name)
                .context("Missing configuration for the origin chain")
                .take_err(&mut err, || cwp.add("origin_chain_name"))
        } else {
            None
        };

        let validator = p
            .chain(&mut err)
            .get_key("validator")
            .parse_from_raw_config::<SignerConf, RawAgentSignerConf, NoFilter>(
                (),
                "Expected valid validator configuration",
                agent_name.to_string(),
            )
            .end();

        let db = p
            .chain(&mut err)
            .get_opt_key("db")
            .parse_from_str("Expected db file path")
            .unwrap_or_else(|| {
                curr_dir.join(format!("validator_db_{}", origin_chain_name.unwrap_or("")))
            });

        let checkpoint_syncer = p
            .chain(&mut err)
            .get_key("checkpointSyncer")
            .and_then(parse_checkpoint_syncer)
            .end();

        cfg_unwrap_all!(cwp, err: [origin_chain_name]);

        let reorg_period = p
            .chain(&mut err)
            .get_key("chains")
            .get_key(origin_chain_name)
            .get_opt_key("blocks")
            .get_opt_key("reorgPeriod")
            .parse_value("Invalid reorgPeriod")
            .unwrap_or(ReorgPeriod::from_blocks(1));

        // Retains the 2s fallback #8843 established: only the precedence is new (explicit
        // `interval` -> chain's `index.interval` -> this default), not the default itself, to
        // avoid widening checkpoint-availability latency for validators that don't configure
        // either.
        const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);
        let explicit_interval_secs = p.chain(&mut err).get_opt_key("interval").parse_u64().end();
        if explicit_interval_secs == Some(0) {
            err.push(
                cwp.clone(),
                eyre::eyre!("`interval` must be greater than zero, or omitted for the 2s default"),
            );
        }
        let chain_interval_secs = p
            .chain(&mut err)
            .get_key("chains")
            .get_key(origin_chain_name)
            .get_opt_key("index")
            .get_opt_key("interval")
            .parse_u64()
            .end();
        if chain_interval_secs == Some(0) {
            err.push(
                cwp.clone(),
                eyre::eyre!(
                    "`chains.{origin_chain_name}.index.interval` must be greater than zero, or omitted for the 2s default"
                ),
            );
        }
        let interval = explicit_interval_secs
            .map(Duration::from_secs)
            .or(chain_interval_secs.map(Duration::from_secs))
            .unwrap_or(DEFAULT_INTERVAL);

        let chain = p
            .chain(&mut err)
            .get_key("chains")
            .get_key(origin_chain_name)
            .end()
            .ok_or_else(|| {
                let mut config_err = ConfigParsingError::default();
                config_err.push(cwp.clone(), eyre::eyre!("chains missing".to_string()));
                config_err
            })?;

        let configured_max_sign_concurrency = p
            .chain(&mut err)
            .get_opt_key("maxSignConcurrency")
            .parse_u64()
            .end();
        let max_sign_concurrency =
            parse_max_sign_concurrency(configured_max_sign_concurrency, cwp, &mut err);

        let websocket_url: Option<url::Url> = p
            .chain(&mut err)
            .get_opt_key("websocketUrl")
            .parse_from_str("Expected a valid Merkle tree hook WebSocket URL")
            .end();
        if let Some(url) = &websocket_url {
            if !matches!(url.scheme(), "ws" | "wss") {
                err.push(
                    cwp.clone(),
                    eyre::eyre!("`websocketUrl` must use ws:// or wss://"),
                );
            }
        }
        if lightweight && websocket_url.is_none() {
            err.push(
                cwp.add("websocketurl"),
                eyre!("websocketUrl is required in lightweight mode"),
            );
        }

        let mut rpcs = get_rpc_urls(&chain, "rpcUrls", "customRpcUrls", &mut err);
        // this is only relevant for cosmos
        rpcs.extend(get_rpc_urls(&chain, "grpcUrls", "customGrpcUrls", &mut err));
        // tron wallet urls
        rpcs.extend(get_rpc_urls(
            &chain,
            "walletUrls",
            "customWalletUrls",
            &mut err,
        ));
        rpcs.extend(get_rpc_urls(
            &chain,
            "walletSolidityUrls",
            "customWalletSolidityUrls",
            &mut err,
        ));

        for removed in ["additionalQuorumRpcUrls", "customAdditionalQuorumRpcUrls"] {
            if chain.chain(&mut err).get_opt_key(removed).end().is_some() {
                err.push(cwp.add("chains").add(origin_chain_name).add(&removed.to_ascii_lowercase()), eyre!(
                    "{removed} was removed; move its endpoints into rpcUrls/customRpcUrls and remove the obsolete setting. Normal mode uses rpcConsensusType; lightweight mode requires two-thirds checkpoint agreement"
                ));
            }
        }

        cfg_unwrap_all!(cwp, err: [base, origin_chain, validator, checkpoint_syncer]);

        let mut base: Settings = base;
        // Tron and Ethereum both use secp256k1 keys, so the validator attestation
        // signer can double as the origin chain signer (used for self-announce txs).
        if matches!(
            origin_chain.domain_protocol(),
            HyperlaneDomainProtocol::Ethereum | HyperlaneDomainProtocol::Tron
        ) {
            if let Some(origin) = base.chains.get_mut(&origin_chain) {
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
            websocket_url,
            lightweight,
            rpcs,
            allow_public_rpcs,
            skip_announce,
            max_sign_concurrency,
        })
    }
}

/// Accept both spellings and bare CLI flags without changing RPC selection.
fn parse_lightweight_flag(raw: &mut Value, cwp: &ConfigPath) -> ConfigResult<bool> {
    for key in ["lightweight", "leightweigt"] {
        if raw.get(key).and_then(Value::as_str) == Some("") {
            // The shared argument loader represents a bare --flag as an empty string.
            raw[key] = Value::Bool(true);
        }
    }
    let mut err = ConfigParsingError::default();
    let parser = ValueParser::new(cwp.clone(), raw);
    let lightweight = parser
        .chain(&mut err)
        .get_opt_key("lightweight")
        .parse_bool()
        .end();
    let alias = parser
        .chain(&mut err)
        .get_opt_key("leightweigt")
        .parse_bool()
        .end();
    if let (Some(lightweight), Some(alias)) = (lightweight, alias) {
        if lightweight != alias {
            err.push(
                cwp.clone(),
                eyre!("lightweight and leightweigt must agree when both are set"),
            );
        }
    }
    err.into_result(lightweight.or(alias).unwrap_or(false))
}

fn parse_max_sign_concurrency(
    configured: Option<u64>,
    cwp: &ConfigPath,
    err: &mut ConfigParsingError,
) -> usize {
    let configured = configured.unwrap_or(50);
    match usize::try_from(configured) {
        Ok(value @ 1..=MAX_SIGN_CONCURRENCY) => value,
        _ => {
            err.push(
                cwp.add("max_sign_concurrency"),
                eyre::eyre!("`maxSignConcurrency` must be between 1 and {MAX_SIGN_CONCURRENCY}"),
            );
            DEFAULT_MAX_SIGN_CONCURRENCY
        }
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
                .map(str::trim)
                .filter(|url| !url.is_empty())
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
            let region: Option<String> = syncer
                .chain(&mut err)
                .get_key("region")
                .parse_string()
                .end()
                .map(str::to_owned);
            let folder = syncer
                .chain(&mut err)
                .get_opt_key("folder")
                .parse_string()
                .end()
                .map(str::to_owned);

            cfg_unwrap_all!(&syncer.cwp, err: [bucket, region]);
            err.into_result(CheckpointSyncerConf::S3 {
                bucket,
                region: Region::new(region),
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
                .get_opt_key("serviceAccountKey")
                .parse_string()
                .end()
                .map(str::to_owned);
            let user_secrets = syncer
                .chain(&mut err)
                .get_opt_key("userSecrets")
                .parse_string()
                .end()
                .map(str::to_owned);
            let use_application_default = syncer
                .chain(&mut err)
                .get_opt_key("useApplicationDefault")
                .parse_bool()
                .end()
                .unwrap_or(false);

            cfg_unwrap_all!(&syncer.cwp, err: [bucket]);
            err.into_result(CheckpointSyncerConf::Gcs {
                bucket,
                folder,
                service_account_key,
                user_secrets,
                use_application_default,
            })
        }
        Some(_) => Err(eyre!("Unknown checkpoint syncer type"))
            .into_config_result(|| (&syncer.cwp).add("type")),
        None => Err(err),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn max_sign_concurrency_is_bounded() {
        let cwp = ConfigPath::default();
        let max_sign_concurrency =
            u64::try_from(MAX_SIGN_CONCURRENCY).expect("MAX_SIGN_CONCURRENCY must fit in u64");

        for (configured, expected) in [
            (None, DEFAULT_MAX_SIGN_CONCURRENCY),
            (Some(1), 1),
            (Some(max_sign_concurrency), MAX_SIGN_CONCURRENCY),
        ] {
            let mut err = ConfigParsingError::default();
            assert_eq!(
                parse_max_sign_concurrency(configured, &cwp, &mut err),
                expected
            );
            assert!(err.is_ok());
        }

        for configured in [0, max_sign_concurrency + 1, u64::MAX] {
            let mut err = ConfigParsingError::default();
            assert_eq!(
                parse_max_sign_concurrency(Some(configured), &cwp, &mut err),
                DEFAULT_MAX_SIGN_CONCURRENCY
            );
            assert!(!err.is_ok());
            assert!(err.to_string().contains("maxSignConcurrency"));
        }
    }

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

    fn lightweight_settings_fixture() -> Value {
        serde_json::json!({
            "lightweight": true,
            "originchainname": "test",
            "websocketurl": "wss://scraper.example/events",
            "validator": {"type": "hexKey", "key": format!("0x{}", "11".repeat(32))},
            "checkpointsyncer": {"type": "localStorage", "path": "/tmp/lightweight-checkpoints"},
            "chains": {"test": {
                "name": "test", "domainid": 1337, "chainid": 1337, "protocol": "ethereum",
                "rpcurls": [
                    {"http": "https://public.example", "public": true},
                    {"http": "https://private.example", "public": false}
                ],
                "customrpcurls": "https://private-override.example",
                "mailbox": "0x0000000000000000000000000000000000000001",
                "interchaingaspaymaster": "0x0000000000000000000000000000000000000002",
                "validatorannounce": "0x0000000000000000000000000000000000000003",
                "merkletreehook": "0x0000000000000000000000000000000000000004"
            }}
        })
    }

    #[test]
    fn removed_quorum_settings_require_migration_in_both_modes() {
        for lightweight in [false, true] {
            for (key, value) in [
                (
                    "additionalquorumrpcurls",
                    serde_json::json!([{"http": "https://quorum.example"}]),
                ),
                ("additionalquorumrpcurls", serde_json::json!([])),
                (
                    "customadditionalquorumrpcurls",
                    serde_json::json!("https://quorum.example"),
                ),
                ("customadditionalquorumrpcurls", serde_json::json!("")),
            ] {
                let mut raw = lightweight_settings_fixture();
                raw["lightweight"] = Value::Bool(lightweight);
                raw["chains"]["test"][key] = value;
                let error = ValidatorSettings::from_config_filtered(
                    RawValidatorSettings(raw),
                    &ConfigPath::default(),
                    (),
                    "validator",
                )
                .expect_err("obsolete quorum configuration must not be silently ignored");
                assert!(error.to_string().contains("was removed"));
            }
        }
    }

    #[test]
    fn lightweight_accepts_bare_flags_and_preserves_rpc_overrides() {
        for flag in ["lightweight", "leightweigt"] {
            let mut raw = lightweight_settings_fixture();
            raw.as_object_mut()
                .expect("config object")
                .remove("lightweight");
            raw[flag] = Value::String(String::new());
            let chains = raw["chains"].clone();
            assert!(parse_lightweight_flag(&mut raw, &ConfigPath::default()).expect("bare flag"));
            assert_eq!(raw["chains"], chains);
            let settings = ValidatorSettings::from_config_filtered(
                RawValidatorSettings(raw),
                &ConfigPath::default(),
                (),
                "validator",
            )
            .expect("valid lightweight configuration");
            assert!(settings.lightweight);
            assert!(settings.allow_public_rpcs);
            assert_eq!(settings.rpcs.len(), 1);
            assert_eq!(settings.rpcs[0].url, "https://private-override.example");
            assert!(!settings.rpcs[0].public);
            let hyperlane_base::settings::ChainConnectionConf::Ethereum(connection) =
                &settings.base.chains[&settings.origin_chain].connection
            else {
                panic!("expected EVM connection");
            };
            assert_eq!(
                connection.rpc_urls(),
                vec![url::Url::parse("https://private-override.example").expect("RPC URL")]
            );
        }
    }

    #[test]
    fn lightweight_accepts_non_evm_validator_configuration() {
        let mut raw = lightweight_settings_fixture();
        raw["chains"]["test"]["protocol"] = Value::String("sealevel".into());
        let settings = ValidatorSettings::from_config_filtered(
            RawValidatorSettings(raw),
            &ConfigPath::default(),
            (),
            "validator",
        )
        .expect("non-EVM lightweight validator");
        assert!(settings.lightweight);
        assert_eq!(
            settings.origin_chain.domain_protocol(),
            HyperlaneDomainProtocol::Sealevel
        );
    }

    #[test]
    fn lightweight_keeps_all_rpc_urls_even_with_single_consensus() {
        for consensus in ["single", "fallback", "quorum"] {
            let mut raw = lightweight_settings_fixture();
            raw["chains"]["test"]
                .as_object_mut()
                .expect("chain object")
                .remove("customrpcurls");
            raw["chains"]["test"]["rpcconsensustype"] = consensus.into();
            let settings = ValidatorSettings::from_config_filtered(
                RawValidatorSettings(raw),
                &ConfigPath::default(),
                (),
                "validator",
            )
            .expect("lightweight configuration");
            assert_eq!(settings.rpcs.len(), 2);
            assert!(settings.rpcs[0].public);
            assert!(!settings.rpcs[1].public);
        }
    }

    #[test]
    fn metadata_includes_cosmos_and_tron_state_read_transports() {
        use crate::validator::ValidatorMetadata;
        use hyperlane_base::MetadataFromSettings;

        for protocol in ["cosmos", "cosmosnative", "tron"] {
            for lightweight in [false, true] {
                let mut raw = lightweight_settings_fixture();
                raw["lightweight"] = lightweight.into();
                let chain = &mut raw["chains"]["test"];
                chain["protocol"] = protocol.into();
                chain["chainid"] = if protocol.starts_with("cosmos") {
                    "test-1"
                } else {
                    "1337"
                }
                .into();
                chain["bech32prefix"] = "test".into();
                chain["gasprice"] = serde_json::json!({"denom": "utest", "amount": "0.1"});
                chain["contractaddressbytes"] = 32.into();
                chain["grpcurls"] = serde_json::json!([{"http": "https://grpc-registry.example"}]);
                chain["customgrpcurls"] = "https://grpc-private.example".into();
                chain["walleturls"] = serde_json::json!([{"http": "https://wallet.example"}]);
                chain["walletsolidityurls"] =
                    serde_json::json!([{"http": "https://solid-registry.example"}]);
                chain["customwalletsolidityurls"] = "https://solid-private.example".into();
                let settings = ValidatorSettings::from_config_filtered(
                    RawValidatorSettings(raw),
                    &ConfigPath::default(),
                    (),
                    "validator",
                )
                .expect("valid transport configuration");
                let metadata = serde_json::to_value(ValidatorMetadata::build_metadata(&settings))
                    .expect("serialized metadata");
                let hashes: Vec<_> = metadata["rpcs"]
                    .as_array()
                    .expect("RPC metadata")
                    .iter()
                    .map(|entry| entry["url_hash"].clone())
                    .collect();
                for url in [
                    "https://private-override.example",
                    "https://grpc-private.example",
                    "https://wallet.example",
                    "https://solid-private.example",
                ] {
                    let expected = serde_json::to_value(hyperlane_core::H256::from(
                        ethers::utils::keccak256(url),
                    ))
                    .expect("hash");
                    assert!(
                        hashes.contains(&expected),
                        "{protocol}, lightweight={lightweight}: missing transport"
                    );
                }
                assert_eq!(hashes.len(), 4);
            }
        }
    }

    #[test]
    fn lightweight_requires_websocket_and_defaults_off() {
        let mut raw = lightweight_settings_fixture();
        raw.as_object_mut()
            .expect("config object")
            .remove("websocketurl");
        let error = ValidatorSettings::from_config_filtered(
            RawValidatorSettings(raw.clone()),
            &ConfigPath::default(),
            (),
            "validator",
        )
        .expect_err("websocket required");
        assert!(error.to_string().contains("websocketUrl is required"));
        raw.as_object_mut()
            .expect("config object")
            .remove("lightweight");
        let settings = ValidatorSettings::from_config_filtered(
            RawValidatorSettings(raw),
            &ConfigPath::default(),
            (),
            "validator",
        )
        .expect("classic configuration");
        assert!(!settings.lightweight);
        assert!(!settings.allow_public_rpcs);
    }

    #[test]
    fn lightweight_rejects_invalid_or_conflicting_flags() {
        for mut raw in [
            serde_json::json!({"lightweight": "invalid"}),
            serde_json::json!({"lightweight": true, "leightweigt": false}),
        ] {
            assert!(parse_lightweight_flag(&mut raw, &ConfigPath::default()).is_err());
        }
        for mut raw in [
            serde_json::json!({}),
            serde_json::json!({"lightweight": false}),
        ] {
            assert!(!parse_lightweight_flag(&mut raw, &ConfigPath::default()).expect("disabled"));
        }
    }
}

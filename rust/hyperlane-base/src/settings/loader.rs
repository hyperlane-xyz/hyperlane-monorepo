use std::collections::HashMap;
use std::env;
use std::error::Error;

use config::{Config, Environment, File};
use eyre::{Context, Result};
use serde::Deserialize;

/// Load a settings object from the config locations.
///
/// Read settings from the config files and/or env
/// The config will be located at `config/default` unless specified
/// otherwise
///
/// Configs are loaded in the following precedence order:
///
/// 1. The file specified by the `RUN_ENV` and `BASE_CONFIG`
///    env vars. `RUN_ENV/BASE_CONFIG`
/// 2. The file specified by the `RUN_ENV` env var and the
///    agent's name. `RUN_ENV/<agent_prefix>-partial.json`
/// 3. Configuration env vars with the prefix `HYP_BASE` intended
///    to be shared by multiple agents in the same environment
/// 4. Configuration env vars with the prefix `HYP_<agent_prefix>`
///    intended to be used by a specific agent.
///
/// Specify a configuration directory with the `RUN_ENV` env
/// variable. Specify a configuration file with the `BASE_CONFIG`
/// env variable.
pub(crate) fn load_settings_object<'de, T: Deserialize<'de>, S: AsRef<str>>(
    agent_prefix: &str,
    ignore_prefixes: &[S],
) -> Result<T> {
    // Derive additional prefix from agent name
    let prefix = format!("HYP_{}", agent_prefix).to_ascii_uppercase();

    let filtered_env: HashMap<String, String> = env::vars()
        .filter(|(k, _v)| {
            !ignore_prefixes
                .iter()
                .any(|prefix| k.starts_with(prefix.as_ref()))
        })
        .collect();

    let builder = Config::builder();

    // Load the base config file the old way
    let builder = match (env::var("RUN_ENV").ok(), env::var("BASE_CONFIG").ok()) {
        (Some(env), Some(fname)) => {
            builder.add_source(File::with_name(&format!("./config/{}/{}", env, fname)))
        }
        _ => builder,
    };

    // Load a set of config files
    let config_file_paths: Vec<String> = env::var("CONFIG_FILES")
        .ok()
        .map(|s| s.split(',').map(|s| s.to_string()).collect())
        .unwrap_or_default();

    let builder = config_file_paths.iter().fold(builder, |builder, path| {
        builder.add_source(File::with_name(path))
    });

    let config_deserializer = builder
        // Use a base configuration env variable prefix
        .add_source(
            Environment::with_prefix("HYP_BASE")
                .separator("_")
                .source(Some(filtered_env.clone())),
        )
        .add_source(
            Environment::with_prefix(&prefix)
                .separator("_")
                .source(Some(filtered_env)),
        )
        .build()?;
    let formatted_config = format!("{:#?}", config_deserializer).replace('\n', "\\n");
    match Config::try_deserialize(config_deserializer) {
        Ok(cfg) => Ok(cfg),
        Err(err) => {
            let err_str = err.to_string();

            let mut err = if let Some(source_err) = err.source() {
                let source = format!("Config error source: {source_err}");
                Err(err).context(source)
            } else {
                Err(err.into())
            };

            println!(
                "Error during deserialization, showing the config for debugging: {}",
                formatted_config
            );

            match err_str
                .contains("missing field")
                .then(|| err_str.split('`').skip(1).next())
                .flatten()
            {
                Some("environment") => err = err.context(MISSING_ENV_CTX),
                Some("name") => err = err.context(MISSING_NAME_CTX),
                Some("domain") => err = err.context(MISSING_DOMAIN_CTX),
                Some("addresses") => err = err.context(MISSING_ADDRESSES_CTX),
                Some("mailbox") => err = err.context(MISSING_MAILBOX_CTX),
                Some("interchainGasPaymaster") => err = err.context(MISSING_IGP_CTX),
                Some("validatorAnnounce") => err = err.context(MISSING_VA_CTX),
                Some("protocol") => err = err.context(MISSING_PROTOCOL_CTX),
                Some("finalityBlocks") => err = err.context(MISSING_FINALITY_CTX),
                Some("connection") => err = err.context(MISSING_CONNECTION_CTX),
                Some("type") => err = err.context(MISSING_TYPE_CTX),
                Some("urls") => err = err.context(MISSING_URLS_CTX),
                Some("url") => err = err.context(MISSING_URL_CTX),
                Some("db") => err = err.context(MISSING_DB_CTX),
                _ => {}
            }

            err
        }
    }
}

/// Some constant strings that we want to compose. `concat!` requires literals so this provides them.
macro_rules! str_lits {
    (bp) => { "Debugging tips, please ensure: " };
    (env) => { "an env such as `HYP_BASE_CHAINS_ALFAJORES_CONNECTION_TYPE` means the full `chains.alfajores` object must be valid" };
}

const MISSING_ENV_CTX: &str = concat!(
    str_lits!(bp),
    "(1) the `environment` config value is set and spelled correctly",
);

const MISSING_NAME_CTX: &str = concat!(
    str_lits!(bp),
    "(1) the `chains` config value is set and spelled correctly ",
    "(2) a connection URL may have been specified for a chain that is not fully configured, e.g. `HYP_BASE_CHAINS_ALFAJORES_CONNECTION_URL` ",
    "(3) ", str_lits!(env), " ",
    "(4) all chains are correctly named e.g. `chains.alfajores` being misspelled may lead to `chains.alfajores.name` not being found"
);

const MISSING_DOMAIN_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.domain` is specified for all chains as a string-typed integer ",
    "(2) ",
    str_lits!(env)
);

const MISSING_ADDRESSES_CTX: &str = concat!(
    str_lits!(bp),
    "(1) the `chains.<chain_name>.addresses` object is specified for all chains ",
    "(2) ",
    str_lits!(env)
);

const MISSING_MAILBOX_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.addresses.mailbox` is specified for all chains ",
    "(2) ",
    str_lits!(env)
);

const MISSING_IGP_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.addresses.interchainGasPaymaster` is specified for all chains ",
    "(2) ",
    str_lits!(env)
);

const MISSING_VA_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.addresses.validatorAnnounce` is specified for all chains ",
    "(2) ",
    str_lits!(env)
);

const MISSING_PROTOCOL_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.protocol` is specified for all chains, e.g. `ethereum` or `fuel` ",
    "(2) ",
    str_lits!(env)
);

const MISSING_FINALITY_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.finalityBlocks` is specified for all chains ",
    "(2) ",
    str_lits!(env)
);

const MISSING_CONNECTION_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.connection object is specified for all chains ",
    "(2) ",
    str_lits!(env)
);

const MISSING_TYPE_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.connection.type` is specified for all chains, e.g. `http`, `httpFallback`, or `httpQuorum` ",
    "(2) ", str_lits!(env)
);

const MISSING_URLS_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.connection.urls` is specified for the chain ",
    "(2) `urls` is used for connection type that accept multiple like `httpQuorum` and `httpFallback` and `url` is used for connection types that only accept a single url like `http` "
);

const MISSING_URL_CTX: &str = concat!(
    str_lits!(bp),
    "(1) `chains.<chain_name>.connection.url` is specified for the chain ",
    "(2) `url` is used for connection types that only accept a single url like `http` and `urls` is used for connection type that accept multiple like `httpQuorum` and `httpFallback`"
);

const MISSING_DB_CTX: &str = concat!(str_lits!(bp), "(1) `db` config string is specified");

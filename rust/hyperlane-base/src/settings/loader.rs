use std::collections::HashMap;
use std::env;

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
    let formatted_config = format!("{:#?}", config_deserializer);
    match serde_path_to_error::deserialize(config_deserializer) {
        Ok(cfg) => Ok(cfg),
        Err(err) => {
            println!("Error during deseriaization, showing the config for debugging:\n {}", formatted_config);
            let ctx = format!("Invalid config at `{}` {:?}", err.path(), err);
            Err(err).context(ctx)
        }
    }
}

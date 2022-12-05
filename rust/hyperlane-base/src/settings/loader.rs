use config::{Config, Environment, File};
use serde::Deserialize;
use std::collections::HashMap;
use std::env;

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
    config_file_name: Option<&str>,
    ignore_prefixes: &[S],
) -> eyre::Result<T> {
    let env = env::var("RUN_ENV").unwrap_or_else(|_| "default".into());

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
    let builder = if let Some(fname) = config_file_name {
        builder.add_source(File::with_name(&format!("./config/{}/{}", env, fname)))
    } else {
        builder
    };
    let config_deserializer = builder
        .add_source(
            File::with_name(&format!(
                "./config/{}/{}-partial",
                env,
                agent_prefix.to_lowercase()
            ))
            .required(false),
        )
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

    Ok(serde_path_to_error::deserialize(config_deserializer)?)
}

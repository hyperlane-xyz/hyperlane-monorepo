use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::path::PathBuf;

use config::{Config, Environment, File};
use eyre::{Context, Result};
use serde::Deserialize;

use crate::settings::RawSettings;

/// Load a settings object from the config locations.
/// Further documentation can be found in the `settings` module.
pub(crate) fn load_settings_object<'de, T, S>(
    agent_prefix: &str,
    ignore_prefixes: &[S],
) -> Result<T>
where
    T: Deserialize<'de> + AsMut<RawSettings>,
    S: AsRef<str>,
{
    // Derive additional prefix from agent name
    let prefix = format!("HYP_{}", agent_prefix).to_ascii_uppercase();

    let filtered_env: HashMap<String, String> = env::vars()
        .filter(|(k, _v)| {
            !ignore_prefixes
                .iter()
                .any(|prefix| k.starts_with(prefix.as_ref()))
        })
        .collect();

    let mut base_config_sources = vec![];
    let mut builder = Config::builder();

    // Always load the default config files (`rust/config/*.json`)
    for entry in PathBuf::from("./config")
        .read_dir()
        .expect("Failed to open config directory")
        .map(Result::unwrap)
    {
        if !entry.file_type().unwrap().is_file() {
            continue;
        }

        let fname = entry.file_name();
        let ext = fname.to_str().unwrap().split('.').last().unwrap_or("");
        if ext == "json" {
            base_config_sources.push(format!("{:?}", entry.path()));
            builder = builder.add_source(File::from(entry.path()));
        }
    }

    // Load a set of additional user specified config files
    let config_file_paths: Vec<String> = env::var("CONFIG_FILES")
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

    let formatted_config = {
        let f = format!("{:#?}", config_deserializer);
        if env::var("ONELINE_BACKTRACES")
            .map(|v| v.to_lowercase())
            .as_deref()
            == Ok("true")
        {
            f.replace('\n', "\\n")
        } else {
            f
        }
    };

    match Config::try_deserialize::<T>(config_deserializer) {
        Ok(mut cfg) => {
            cfg.as_mut();
            Ok(cfg)
        }
        Err(err) => {
            // let mut err: Report = match err {
            //     ConfigError::Foreign(err) => {
            //         err.downcast::<Report>().map(|b| *b).or_else(|err| Ok(err.into())).unwrap()
            //     }
            //     err => err.into(),
            // };

            let mut err = if let Some(source_err) = err.source() {
                let source = format!("Config error source: {source_err}");
                Err(err).context(source)
            } else {
                Err(err.into())
            };

            println!("Err: {:?}", err.as_ref().err().unwrap());

            for cfg_path in base_config_sources.iter().chain(config_file_paths.iter()) {
                err = err.with_context(|| format!("Config loaded: {cfg_path}"));
            }

            println!("Err: {:?}", err.as_ref().err().unwrap());

            println!(
                "Error during deserialization, showing the config for debugging: {}",
                formatted_config
            );

            err.context("Config deserialization error, please check the config reference (https://docs.hyperlane.xyz/docs/operators/agent-configuration/reference)")
        }
    }
}

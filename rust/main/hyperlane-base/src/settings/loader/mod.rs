//! Load a settings object from the config locations.

use std::{env, error::Error, fmt::Debug, path::PathBuf};

use config::{Config, File};
use convert_case::Case;
use eyre::{eyre, Context, Result};
use hyperlane_core::config::*;
use serde::de::DeserializeOwned;

use crate::settings::loader::{
    arguments::CommandLineArguments, case_adapter::CaseAdapter, environment::Environment,
};

mod arguments;
mod case_adapter;
mod environment;

/// Deserialize a settings object from the configs.
pub fn load_settings<T, R>(agent_name: &str) -> ConfigResult<R>
where
    T: DeserializeOwned + Debug,
    R: FromRawConf<T>,
{
    let now = chrono::Utc::now();
    println!("Loading settings: {:?}", now);

    let root_path = ConfigPath::default();

    let mut base_config_sources = vec![];
    let mut builder = Config::builder();

    // Always load the default config files (`rust/main/config/*.json`)
    for entry in PathBuf::from("./config")
        .read_dir()
        .context("Failed to open config directory")
        .into_config_result(|| root_path.clone())?
        .map(Result::unwrap)
    {
        if !entry.file_type().unwrap().is_file() {
            continue;
        }

        let entry_path = entry.path();
        let ext = entry_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if ext == "json" {
            base_config_sources.push(format!("{:?}", entry_path));
            builder = builder.add_source(CaseAdapter::new(File::from(entry_path), Case::Flat));
        }
    }

    // Load a set of additional user specified config files
    let config_file_paths: Vec<String> = env::var("CONFIG_FILES")
        .map(|s| s.split(',').map(|s| s.to_owned()).collect())
        .unwrap_or_default();

    for path in &config_file_paths {
        let p = PathBuf::from(path);
        if p.is_file() {
            if p.extension() == Some("json".as_ref()) {
                let config_file = File::from(p);
                let re_cased_config_file = CaseAdapter::new(config_file, Case::Flat);
                builder = builder.add_source(re_cased_config_file);
            } else {
                return Err(eyre!(
                    "Provided config path via CONFIG_FILES is of an unsupported type ({p:?})"
                ))
                .into_config_result(|| root_path.clone());
            }
        } else if !p.exists() {
            return Err(eyre!(
                "Provided config path via CONFIG_FILES does not exist ({p:?})"
            ))
            .into_config_result(|| root_path.clone());
        } else {
            return Err(eyre!(
                "Provided config path via CONFIG_FILES is not a file ({p:?})"
            ))
            .into_config_result(|| root_path.clone());
        }
    }

    let config_deserializer = builder
        // Use a base configuration env variable prefix
        .add_source(CaseAdapter::new(
            Environment::default().prefix("HYP_").separator("_"),
            Case::Flat,
        ))
        .add_source(CaseAdapter::new(
            CommandLineArguments::default().separator("."),
            Case::Flat,
        ))
        .build()
        .context("Failed to load config sources")
        .into_config_result(|| root_path.clone())?;

    let formatted_config = {
        let f = format!("{config_deserializer:#?}");
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

    let raw_config = Config::try_deserialize::<T>(config_deserializer)
        .or_else(|err| {
            let mut err = if let Some(source_err) = err.source() {
                let source = format!("Config error source: {source_err}");
                Err(err).context(source)
            } else {
                Err(err.into())
            };

            for cfg_path in base_config_sources.iter().chain(config_file_paths.iter()) {
                err = err.with_context(|| format!("Config loaded: {cfg_path}"));
            }
            eprintln!("Loaded config for debugging: {formatted_config}");
            err.context("Config deserialization error, please check the config reference (https://docs.hyperlane.xyz/docs/operators/agent-configuration/configuration-reference)")
        })
        .into_config_result(|| root_path.clone())?;

    let res = raw_config.parse_config(&root_path, agent_name);
    if res.is_err() {
        eprintln!("Loaded config for debugging: {formatted_config}");
    }

    let now = chrono::Utc::now();
    println!("Loaded settings: {:?}", now);

    res
}

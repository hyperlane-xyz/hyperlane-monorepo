use std::collections::HashMap;
use std::env;

use config::{Config, Environment, File};

use abacus_base::macros::load_settings_object;
use abacus_base::{decl_settings, AgentSettings, ApplicationSettings, ChainSettings, Settings};

pub struct ScraperSettings {
    /// settings by domain id for each domain
    chains: HashMap<u32, ChainSettings>,
    app: ApplicationSettings,
}

impl ScraperSettings {
    fn for_domain(&self, domain: u32) -> &ChainSettings {
        self.chains
            .get(&domain)
            .expect("Missing configuration for domain")
    }
}

impl AsRef<ApplicationSettings> for ScraperSettings {
    fn as_ref(&self) -> &ApplicationSettings {
        &self.app
    }
}

impl AgentSettings for ScraperSettings {
    type Error = config::ConfigError;

    fn new() -> Result<Self, Self::Error> {
        Ok(Self {
            app: load_settings_object(
                "scraper",
                &env::var("BASE_CONFIG").unwrap_or_else(|_| "base".into()),
            )?,
            chains: env::vars()
                .filter(|(k, _)| k.starts_with("BASE_CONFIG_") && k.len() > 12)
                .map(|(env_var_name, config_file_name)| {
                    let chain_name = env_var_name
                        .chars()
                        .skip(12)
                        .map(|c| c.to_ascii_lowercase())
                        .collect::<String>();
                    let settings: ChainSettings =
                        load_settings_object(&format!("scraper_{chain_name}"), &config_file_name)?;
                    let domain: u32 = settings.outbox.domain.parse().expect("Invalid uint");
                    Ok((domain, settings))
                })
                .collect::<Result<_, _>>()?,
        })
    }
}

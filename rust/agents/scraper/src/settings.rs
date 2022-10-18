use std::collections::HashMap;

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
        todo!()
    }
}

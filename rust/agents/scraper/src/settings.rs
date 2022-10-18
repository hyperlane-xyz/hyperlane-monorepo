use std::collections::HashMap;

use abacus_base::{decl_settings, AgentSettings, Settings};

pub struct ScraperSettings {
    /// settings by domain id for each domain
    settings: HashMap<u32, Settings>,
}

impl ScraperSettings {
    fn for_domain(&self, domain: u32) -> &Settings {
        self.settings
            .get(&domain)
            .expect("Missing configuration for domain")
    }
}

impl AsRef<Settings> for ScraperSettings {
    fn as_ref(&self) -> &Settings {
        todo!()
    }
}

impl AgentSettings for ScraperSettings {
    type Error = config::ConfigError;

    fn new() -> Result<Self, Self::Error> {
        todo!()
    }
}

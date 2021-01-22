use config::{Config, ConfigError, Environment, File};
use std::{collections::HashMap, env};

use ethers_core::types::{Address, H256};

#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum Ethereum {
    Http { address: Address, http: String },
    Ws { address: Address, ws: String },
}

impl Ethereum {
    pub fn url(&self) -> &str {
        match self {
            Self::Http { address: _, http } => &http,
            Self::Ws { address: _, ws } => &ws,
        }
    }

    pub fn address(&self) -> Address {
        match self {
            Self::Http { address, http: _ } => *address,
            Self::Ws { address, ws: _ } => *address,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "chain")]
pub(crate) enum Home {
    Ethereum(Ethereum),
}

impl Home {
    pub fn url(&self) -> &str {
        match self {
            Self::Ethereum(e) => e.url(),
        }
    }

    pub fn address(&self) -> H256 {
        match self {
            Self::Ethereum(e) => e.address().into(),
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "chain")]
pub(crate) enum Replica {
    Ethereum(Ethereum),
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct Settings {
    home: Home,
    replicas: HashMap<String, Replica>,
}

impl Settings {
    pub fn new() -> Result<Self, ConfigError> {
        let mut s = Config::new();

        s.merge(File::with_name("config/default"))?;

        let env = env::var("RUN_MODE").unwrap_or_else(|_| "development".into());
        s.merge(File::with_name(&format!("config/{}", env)).required(false))?;

        // Add in settings from the environment (with a prefix of OPTRELAY)
        // Eg.. `OPTRELAY_DEBUG=1 would set the `debug` key
        s.merge(Environment::with_prefix("OPTRELAY"))?;

        s.try_into()
    }
}

impl Settings {
    pub fn home(&self) -> &Home {
        &self.home
    }

    pub fn replicas(&self) -> &HashMap<String, Replica> {
        &self.replicas
    }
}

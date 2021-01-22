use config::{Config, ConfigError, Environment, File};
use std::{collections::HashMap, convert::TryFrom, env};

use ethers_core::types::Address;
use ethers_providers::{Http, Provider, Ws};

use optics_core::traits::Home;

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
pub(crate) enum EthereumConf {
    Http { url: String },
    Ws { url: String },
}

impl EthereumConf {
    async fn try_home(&self, slip44: u32, address: Address) -> Result<Box<dyn Home>, String> {
        let b: Box<dyn Home> = match self {
            Self::Http { url } => {
                let provider = Provider::<Http>::try_from(url.as_ref()).map_err(|_| "!url")?;
                Box::new(crate::abis::HomeContract::at(
                    slip44,
                    address,
                    provider.into(),
                ))
            }
            Self::Ws { url } => {
                let ws = Ws::connect(url).await.map_err(|_| "!ws connect")?;
                let provider = Provider::new(ws);
                Box::new(crate::abis::HomeContract::at(
                    slip44,
                    address,
                    provider.into(),
                ))
            }
        };
        Ok(b)
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "chain", content = "connection")]
pub(crate) enum ChainConnection {
    Ethereum(EthereumConf),
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct ChainSetup {
    slip44: u32,
    address: String,
    #[serde(flatten)]
    connection: ChainConnection,
}

impl ChainSetup {
    pub async fn try_into_home(&self) -> Result<Box<dyn Home>, String> {
        match &self.connection {
            ChainConnection::Ethereum(conf) => {
                conf.try_home(self.slip44, self.address.parse().map_err(|_| "!address")?)
                    .await
            }
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct Settings {
    pub(crate) home: ChainSetup,
    pub(crate) replicas: HashMap<String, ChainSetup>,
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

use config::{Config, ConfigError, Environment, File};
use std::{collections::HashMap, convert::TryFrom, env};

use ethers_core::types::Address;
use ethers_providers::{Http, Provider, Ws};

use optics_core::traits::{Home, Replica};

/// Ethereum connection configuration
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
pub enum EthereumConf {
    Http { url: String },
    Ws { url: String },
}

impl EthereumConf {
    /// Try to convert this into a home contract
    async fn try_into_home(&self, slip44: u32, address: Address) -> Result<Box<dyn Home>, String> {
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

    /// Try to convert this into a replica contract
    pub async fn try_into_replica(
        &self,
        slip44: u32,
        address: Address,
    ) -> Result<Box<dyn Replica>, String> {
        let b: Box<dyn Replica> = match self {
            Self::Http { url } => {
                let provider = Provider::<Http>::try_from(url.as_ref()).map_err(|_| "!url")?;
                Box::new(crate::abis::ReplicaContract::at(
                    slip44,
                    address,
                    provider.into(),
                ))
            }
            Self::Ws { url } => {
                let ws = Ws::connect(url).await.map_err(|_| "!ws connect")?;
                let provider = Provider::new(ws);
                Box::new(crate::abis::ReplicaContract::at(
                    slip44,
                    address,
                    provider.into(),
                ))
            }
        };
        Ok(b)
    }
}

/// A connection to _some_ blockchain.
///
/// Specify the chain name (enum variant) in toml under the `chain` key
/// Specify the connection details as a toml object under the `connection` key.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "chain", content = "connection")]
pub enum ChainConnection {
    Ethereum(EthereumConf),
}

/// A chain setup is a slip44 ID, an address on that chain (where the home or
/// replica is deployed) and details for connecting to the chain API.
#[derive(Debug, serde::Deserialize)]
pub struct ChainSetup {
    slip44: u32,
    address: String,
    #[serde(flatten)]
    connection: ChainConnection,
}

impl ChainSetup {
    pub async fn try_into_home(&self) -> Result<Box<dyn Home>, String> {
        match &self.connection {
            ChainConnection::Ethereum(conf) => {
                conf.try_into_home(self.slip44, self.address.parse().map_err(|_| "!address")?)
                    .await
            }
        }
    }

    pub async fn try_into_replica(&self) -> Result<Box<dyn Replica>, String> {
        match &self.connection {
            ChainConnection::Ethereum(conf) => {
                conf.try_into_replica(self.slip44, self.address.parse().map_err(|_| "!address")?)
                    .await
            }
        }
    }
}

/// Settings. Usually this should be treated as a base config and used as
/// follows:
///
/// ```
/// use optics_base::settings::*;
///
/// pub struct OtherSettings { /* anything */ };
///
/// #[derive(Debug, serde::Deseirialize)]
/// pub struct MySettings {
///     #[serde(flatten)]
///     base_settings: Settings,
///     #[serde(flatten)]
///     other_settings: (),
/// }
///
/// // Make sure to define MySettings::new()
/// impl MySettings {
///     fn new() -> Self {
///         unimplemented!()
///     }
/// }
/// ```
#[derive(Debug, serde::Deserialize)]
pub struct Settings {
    pub home: ChainSetup,
    pub replicas: HashMap<String, ChainSetup>,
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

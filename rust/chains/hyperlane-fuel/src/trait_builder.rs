use fuels::client::FuelClient;
use fuels::prelude::Provider;

/// Fuel connection configuration
#[derive(Debug, serde::Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectionConf {
    /// HTTP connection details
    Http {
        /// Fully qualified string to connect to
        url: String,
    },
}

fn make_client(conf: &ConnectionConf) -> Result<FuelClient, ()> {
    match conf {
        ConnectionConf::Http { url } => FuelClient::new(url).map_err(|_| todo!()),
    }
}

pub fn make_provider(conf: &ConnectionConf) -> Result<Provider, ()> {
    Ok(Provider::new(make_client(conf)?))
}

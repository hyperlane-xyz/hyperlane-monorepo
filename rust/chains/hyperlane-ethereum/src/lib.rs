//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;

use ethers::abi::FunctionExt;
use ethers::prelude::{abi, BlockId, BlockNumber, Http, Lazy, Middleware, NameOrAddress, Provider};
use serde::Deserialize;
use url::Url;

use hyperlane_core::{config::*, Address, Balance, ChainCommunicationError, ChainResult, H160};

#[cfg(not(doctest))]
pub use self::{
    interchain_gas::*, interchain_security_module::*, mailbox::*, multisig_ism::*, provider::*,
    rpc_clients::*, signers::*, trait_builder::*, validator_announce::*,
};

#[cfg(not(doctest))]
mod tx;

/// Mailbox abi
#[cfg(not(doctest))]
mod mailbox;

#[cfg(not(doctest))]
mod trait_builder;

/// Provider abi
#[cfg(not(doctest))]
mod provider;

/// InterchainGasPaymaster abi
#[cfg(not(doctest))]
mod interchain_gas;

/// interchain_security_module abi
#[cfg(not(doctest))]
mod interchain_security_module;

/// MultisigIsm abi
#[cfg(not(doctest))]
mod multisig_ism;

/// ValidatorAnnounce abi
#[cfg(not(doctest))]
mod validator_announce;

/// Generated contract bindings.
#[cfg(not(doctest))]
mod contracts;

/// Ethers JSONRPC Client implementations
mod rpc_clients;

mod signers;

/// Ethereum connection configuration
#[derive(Debug, Clone)]
pub enum ConnectionConf {
    /// An HTTP-only quorum.
    HttpQuorum {
        /// List of urls to connect to
        urls: Vec<Url>,
    },
    /// An HTTP-only fallback set.
    HttpFallback {
        /// List of urls to connect to in order of priority
        urls: Vec<Url>,
    },
    /// HTTP connection details
    Http {
        /// Url to connect to
        url: Url,
    },
    /// Websocket connection details
    Ws {
        /// Url to connect to
        url: Url,
    },
}

/// Ethereum connection configuration
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawConnectionConf {
    /// The type of connection to use
    #[serde(rename = "type")]
    connection_type: Option<String>,
    /// A single url to connect to
    url: Option<String>,
    /// A comma separated list of urls to connect to
    urls: Option<String>,
}

/// Error type when parsing a connection configuration.
#[derive(Debug, thiserror::Error)]
pub enum ConnectionConfError {
    /// Unknown connection type was specified
    #[error("Unsupported connection type '{0}'")]
    UnsupportedConnectionType(String),
    /// The url was not specified
    #[error("Missing `url` for connection configuration")]
    MissingConnectionUrl,
    /// The urls were not specified
    #[error("Missing `urls` for connection configuration")]
    MissingConnectionUrls,
    /// The could not be parsed
    #[error("Invalid `url` for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrl(String, url::ParseError),
    /// One of the urls could not be parsed
    #[error("Invalid `urls` list for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrls(String, url::ParseError),
    /// The url was empty
    #[error("The `url` value is empty")]
    EmptyUrl,
    /// The urls were empty
    #[error("The `urls` value is empty")]
    EmptyUrls,
}

impl FromRawConf<'_, RawConnectionConf> for ConnectionConf {
    fn from_config_filtered(
        raw: RawConnectionConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        use ConnectionConfError::*;

        let connection_type = raw.connection_type.as_deref().unwrap_or("http");

        let urls = (|| -> ConfigResult<Vec<Url>> {
            raw.urls
                .as_ref()
                .ok_or(MissingConnectionUrls)
                .into_config_result(|| cwp + "urls")?
                .split(',')
                .map(|s| s.parse())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| InvalidConnectionUrls(raw.urls.clone().unwrap(), e))
                .into_config_result(|| cwp.join("urls"))
        })();

        let url = (|| -> ConfigResult<Url> {
            raw.url
                .as_ref()
                .ok_or(MissingConnectionUrl)
                .into_config_result(|| cwp + "url")?
                .parse()
                .map_err(|e| InvalidConnectionUrl(raw.url.clone().unwrap(), e))
                .into_config_result(|| cwp.join("url"))
        })();

        macro_rules! make_with_urls {
            ($variant:ident) => {
                if let Ok(urls) = urls {
                    Ok(Self::$variant { urls })
                } else if let Ok(url) = url {
                    Ok(Self::$variant { urls: vec![url] })
                } else {
                    Err(urls.unwrap_err())
                }
            };
        }

        match connection_type {
            "httpQuorum" => make_with_urls!(HttpQuorum),
            "httpFallback" => make_with_urls!(HttpFallback),
            "http" => Ok(Self::Http { url: url? }),
            "ws" => Ok(Self::Ws { url: url? }),
            t => Err(UnsupportedConnectionType(t.into())).into_config_result(|| cwp.join("type")),
        }
    }
}

#[allow(dead_code)]
/// A live connection to an ethereum-compatible chain.
pub struct Chain {
    creation_metadata: ConnectionConf,
    ethers: Provider<Http>,
}

#[async_trait::async_trait]
impl hyperlane_core::Chain for Chain {
    async fn query_balance(&self, addr: Address) -> ChainResult<Balance> {
        use num::{BigInt, Num};

        let balance = format!(
            "{:x}",
            self.ethers
                .get_balance(
                    NameOrAddress::Address(H160::from_slice(&addr.0[..])),
                    Some(BlockId::Number(BlockNumber::Latest))
                )
                .await?
        );
        let balance =
            BigInt::from_str_radix(&balance, 16).map_err(ChainCommunicationError::from_other)?;

        Ok(Balance(balance))
    }
}

fn extract_fn_map(abi: &'static Lazy<abi::Abi>) -> HashMap<Vec<u8>, &'static str> {
    abi.functions()
        .map(|f| (f.selector().to_vec(), f.name.as_str()))
        .collect()
}

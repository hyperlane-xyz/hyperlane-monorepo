//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;

use ethers::abi::FunctionExt;
use ethers::prelude::{abi, BlockId, BlockNumber, Http, Lazy, Middleware, NameOrAddress, Provider};
use serde::Deserialize;
use url::Url;

use hyperlane_core::*;
pub use retrying::{RetryingProvider, RetryingProviderError};

#[cfg(not(doctest))]
pub use crate::{
    fallback::*, interchain_gas::*, mailbox::*, multisig_ism::*, provider::*, signers::*,
    trait_builder::*, validator_announce::*,
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

/// MultisigIsm abi
#[cfg(not(doctest))]
mod multisig_ism;

/// ValidatorAnnounce abi
#[cfg(not(doctest))]
mod validator_announce;

/// Generated contract bindings.
#[cfg(not(doctest))]
mod contracts;

/// Retrying Provider
mod retrying;

/// Fallback provider
mod fallback;

mod signers;

/// Ethereum connection configuration
#[derive(Debug, Clone)]
pub enum ConnectionConf {
    /// An HTTP-only quorum.
    HttpQuorum {
        /// List of fully qualified strings to connect to
        urls: Vec<Url>,
    },
    /// An HTTP-only fallback set.
    HttpFallback {
        /// List of fully qualified strings to connect to in order of priority
        urls: Vec<Url>,
    },
    /// HTTP connection details
    Http {
        /// Fully qualified string to connect to
        url: Url,
    },
    /// Websocket connection details
    Ws {
        /// Fully qualified string to connect to
        url: Url,
    },
}

/// Raw ethereum connection configuration used for better deserialization
/// errors.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RawConnectionConf {
    HttpQuorum { urls: Option<String> },
    HttpFallback { urls: Option<String> },
    Http { url: Option<String> },
    Ws { url: Option<String> },
}

/// Error type when parsing a connection configuration.
#[derive(Debug, thiserror::Error)]
pub enum ConnectionConfError {
    #[error("Unsupported connection type: {0}")]
    UnsupportedConnectionType(String),
    #[error("Missing `url` for connection configuration")]
    MissingConnectionUrl,
    #[error("Missing `urls` for connection configuration")]
    MissingConnectionUrls,
    #[error("Invalid `url` for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrl(String, url::ParseError),
    #[error("Invalid `urls` list for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrls(String, url::ParseError),
    #[error("The `url` value is empty")]
    EmptyUrl,
    #[error("The `urls` value is empty")]
    EmptyUrls,
}

impl TryFrom<RawConnectionConf> for ConnectionConf {
    type Error = ConnectionConfError;

    fn try_from(r: RawConnectionConf) -> Result<Self, Self::Error> {
        use ConnectionConfError::*;
        use RawConnectionConf::*;
        match r {
            HttpQuorum { urls: None } | HttpFallback { urls: None } => Err(MissingConnectionUrls),
            HttpQuorum { urls: Some(urls) } | HttpFallback { urls: Some(urls) }
                if urls.is_empty() =>
            {
                Err(EmptyUrls)
            }
            Http { url: None } | Ws { url: None } => Err(MissingConnectionUrl),
            Http { url: Some(url) } | Ws { url: Some(url) } if url.is_empty() => Err(EmptyUrl),
            HttpQuorum { urls: Some(urls) } => Ok(Self::HttpQuorum {
                urls: urls
                    .split(',')
                    .map(|s| s.parse())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| InvalidConnectionUrls(urls, e))?,
            }),
            HttpFallback { urls: Some(urls) } => Ok(Self::HttpFallback {
                urls: urls
                    .split(',')
                    .map(|s| s.parse())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| InvalidConnectionUrls(urls, e))?,
            }),
            Http { url: Some(url) } => Ok(Self::Http {
                url: url.parse().map_err(|e| InvalidConnectionUrl(url, e))?,
            }),
            Ws { url: Some(url) } => Ok(Self::Ws {
                url: url.parse().map_err(|e| InvalidConnectionUrl(url, e))?,
            }),
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

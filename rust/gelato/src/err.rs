use crate::chains::Chain;
use rustc_hex::FromHexError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GelatoError {
    #[error("Invalid hex address, couldn't parse '0x{0}'")]
    RelayForwardAddressParseError(FromHexError),
    #[error("No valid relay forward address for target chain '{0}'")]
    UnknownRelayForwardAddress(Chain),
    #[error("HTTP error: {0:#?}")]
    RelayForwardHTTPError(reqwest::Error),
    #[error("Unknown or unmapped chain with name '{0}'")]
    UnknownChainNameError(String),
}

impl From<FromHexError> for GelatoError {
    fn from(err: FromHexError) -> Self {
        GelatoError::RelayForwardAddressParseError(err)
    }
}

impl From<reqwest::Error> for GelatoError {
    fn from(err: reqwest::Error) -> Self {
        GelatoError::RelayForwardHTTPError(err)
    }
}

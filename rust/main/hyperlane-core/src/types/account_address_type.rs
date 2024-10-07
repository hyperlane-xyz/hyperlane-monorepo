use std::error::Error;
use std::str::FromStr;

use derive_more::Display;

#[derive(Debug, Display)]
pub enum AccountAddressTypeError {
    Unknown(String),
}

impl Error for AccountAddressTypeError {}

/// Specifies the account id (address) type
#[derive(Clone, Debug, Default)]
pub enum AccountAddressType {
    /// Bitcoin style address: RIPEMD160(SHA256(pubkey))
    #[default]
    Bitcoin,
    /// Ethereum style address: KECCAK256(pubkey)[20]
    Ethereum,
}

impl TryFrom<&str> for AccountAddressType {
    type Error = AccountAddressTypeError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "BITCOIN" => Ok(AccountAddressType::Bitcoin),
            "ETHEREUM" => Ok(AccountAddressType::Ethereum),
            _ => Err(AccountAddressTypeError::Unknown(format!(
                "unsupported account address type: {}, supported types: BITCOIN, ETHEREUM",
                value
            ))),
        }
    }
}

impl TryFrom<String> for AccountAddressType {
    type Error = AccountAddressTypeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        AccountAddressType::try_from(value.as_str())
    }
}

impl TryFrom<&String> for AccountAddressType {
    type Error = AccountAddressTypeError;

    fn try_from(value: &String) -> Result<Self, Self::Error> {
        AccountAddressType::try_from(value.as_str())
    }
}

impl FromStr for AccountAddressType {
    type Err = AccountAddressTypeError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        AccountAddressType::try_from(s)
    }
}

use crate::HyperlaneCosmosError;

/// Specifies the account id (address) type
pub enum AccountIdType {
    /// Bitcoin style address: RIPEMD160(SHA256(pubkey))
    BITCOIN,
    /// Ethereum style address: KECCAK256(pubkey)[20]
    ETHEREUM,
}

impl TryFrom<&str> for AccountIdType {
    type Error = HyperlaneCosmosError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "BITCOIN" => Ok(AccountIdType::BITCOIN),
            "ETHEREUM" => Ok(AccountIdType::ETHEREUM),
            _ => Err(HyperlaneCosmosError::PublicKeyError(format!(
                "unsupported account id type: {}, supported types: BITCOIN, ETHEREUM",
                value
            ))),
        }
    }
}

impl TryFrom<String> for AccountIdType {
    type Error = HyperlaneCosmosError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        AccountIdType::try_from(value.as_str())
    }
}

impl TryFrom<&String> for AccountIdType {
    type Error = HyperlaneCosmosError;

    fn try_from(value: &String) -> Result<Self, Self::Error> {
        AccountIdType::try_from(value.as_str())
    }
}

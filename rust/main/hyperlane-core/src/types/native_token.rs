/// Chain native token denomination and number of decimal places
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct NativeToken {
    /// The number of decimal places in token which can be expressed by denomination
    pub decimals: u32,
    /// Token symbol (e.g. "ETH", "AVAX")
    pub symbol: String,
    /// Denomination of the token (used primarily by Cosmos chains)
    pub denom: String,
}

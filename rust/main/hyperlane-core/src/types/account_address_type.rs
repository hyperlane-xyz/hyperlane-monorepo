/// Specifies the account address type
#[derive(
    Clone, Debug, Default, strum::Display, strum::EnumString, strum::IntoStaticStr, strum::EnumIter,
)]
pub enum AccountAddressType {
    /// Bitcoin style address: RIPEMD160(SHA256(pubkey))
    #[default]
    Bitcoin,
    /// Ethereum style address: KECCAK256(pubkey)[20]
    Ethereum,
}

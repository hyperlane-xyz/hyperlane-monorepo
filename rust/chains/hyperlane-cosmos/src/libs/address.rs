use std::str::FromStr;

use cosmrs::{crypto::secp256k1::SigningKey, AccountId};
use derive_new::new;
use hyperlane_core::{ChainResult, H256};

/// decode bech32 address to H256
pub fn bech32_decode(addr: String) -> ChainResult<H256> {
    let account_id = AccountId::from_str(&addr)?;

    // although `from_slice` can panic if the slice is not 32 bytes long,
    // we know that we're passing in a value that is 32 bytes long because it was decoded from
    // bech32
    Ok(H256::from_slice(&account_id.to_bytes()))
}

/// Wrapper around the cosmrs AccountId type that abstracts keypair conversions and
/// bech32 encoding
#[derive(new)]
pub struct CosmosAddress {
    account_id: AccountId,
}

impl CosmosAddress {
    /// Returns a Bitcoin style address: RIPEMD160(SHA256(pubkey))
    /// Source: https://github.com/cosmos/cosmos-sdk/blob/177e7f45959215b0b4e85babb7c8264eaceae052/crypto/keys/secp256k1/secp256k1.go#L154
    pub fn from_pubkey(pub_key: &[u8], prefix: &str) -> ChainResult<Self> {
        let account_id = AccountId::new(prefix, pub_key)?;
        Ok(Self { account_id })
    }

    /// Creates a wrapper arround a cosmrs AccountId from a private key byte array
    pub fn from_privkey(priv_key: &[u8], prefix: &str) -> ChainResult<Self> {
        let pubkey = SigningKey::from_slice(priv_key)?.public_key().to_bytes();
        Self::from_pubkey(&pubkey, prefix)
    }

    /// Creates a wrapper arround a cosmrs AccountId from a H256 digest
    pub fn from_h256(digest: H256, prefix: &str) -> ChainResult<Self> {
        let bytes = digest.as_bytes();
        CosmosAddress::from_pubkey(bytes, prefix)
    }

    /// String representation of a cosmos AccountId
    pub fn address(&self) -> String {
        self.account_id.to_string()
    }
}

/// encode H256 to bech32 address
pub fn pub_to_addr(pub_key: Vec<u8>, prefix: &str) -> ChainResult<String> {
    Ok(CosmosAddress::from_pubkey(&pub_key, prefix)?.address())
}

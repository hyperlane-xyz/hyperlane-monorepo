use std::str::FromStr;

use cosmrs::{crypto::secp256k1::SigningKey, AccountId};
use derive_new::new;
use hyperlane_core::{ChainResult, Error::Overflow, H256};

/// decode bech32 address to H256
pub fn bech32_decode(addr: String) -> ChainResult<H256> {
    let account_id = AccountId::from_str(&addr)?;
    let bytes = account_id.to_bytes();
    let h256_len = H256::len_bytes();
    let Some(start_point) = h256_len.checked_sub(bytes.len()) else {
        // input is too large to fit in a H256
        return Err(Overflow.into());
    };
    let mut empty_hash = H256::default();
    let result = empty_hash.as_bytes_mut();
    result[start_point..].copy_from_slice(bytes.as_slice());
    Ok(H256::from_slice(result))
}

/// Wrapper around the cosmrs AccountId type that abstracts keypair conversions and
/// bech32 encoding
#[derive(new, Debug)]
pub struct CosmosAddress {
    account_id: AccountId,
    digest: H256,
}

impl CosmosAddress {
    /// Returns a Bitcoin style address: RIPEMD160(SHA256(pubkey))
    /// Source: https://github.com/cosmos/cosmos-sdk/blob/177e7f45959215b0b4e85babb7c8264eaceae052/crypto/keys/secp256k1/secp256k1.go#L154
    pub fn from_pubkey(pub_key: &[u8], prefix: &str) -> ChainResult<Self> {
        let account_id = AccountId::new(prefix, pub_key)?;
        let digest = bech32_decode(account_id.to_string())?;
        Ok(Self { account_id, digest })
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

    /// H256 digest of the cosmos AccountId
    pub fn digest(&self) -> H256 {
        self.digest
    }
}

/// encode H256 to bech32 address
pub fn pub_to_addr(pub_key: Vec<u8>, prefix: &str) -> ChainResult<String> {
    Ok(CosmosAddress::from_pubkey(&pub_key, prefix)?.address())
}

#[cfg(test)]
pub mod test {
    use hyperlane_core::utils::hex_or_base58_to_h256;

    use super::*;

    #[test]
    fn test_bech32_decode() {
        let addr = "dual1pk99xge6q94qtu3568x3qhp68zzv0mx7za4ct008ks36qhx5tvss3qawfh";
        let decoded =
            bech32_decode(addr.to_string()).expect("decoding of a valid address shouldn't panic");
        assert_eq!(
            decoded,
            H256::from_str("0d8a53233a016a05f234d1cd105c3a3884c7ecde176b85bde7b423a05cd45b21")
                .unwrap()
        );
    }

    #[test]
    fn test_bech32_decode_from_cosmos_key() {
        let hex_key = "0x5486418967eabc770b0fcb995f7ef6d9a72f7fc195531ef76c5109f44f51af26";
        let key = hex_or_base58_to_h256(hex_key).unwrap();
        let prefix = "neutron";
        let addr = CosmosAddress::from_privkey(key.as_bytes(), prefix)
            .expect("Cosmos address creation failed");
        assert_eq!(
            addr.address(),
            "neutron1qvxyspfhvy6xth4w240lvxngp6k0ytskd9w4uxpve4lrzjdm050uqxvtda6"
        );
    }
}

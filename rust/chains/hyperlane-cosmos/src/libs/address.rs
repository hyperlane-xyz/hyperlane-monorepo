use std::str::FromStr;

use cosmrs::{
    crypto::{secp256k1::SigningKey, PublicKey},
    AccountId,
};
use derive_new::new;
use hyperlane_core::{ChainCommunicationError, ChainResult, Error::Overflow, H256};
use tendermint::account::Id as TendermintAccountId;
use tendermint::public_key::PublicKey as TendermintPublicKey;

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
    pub fn from_pubkey(pubkey: PublicKey, prefix: &str) -> ChainResult<Self> {
        // Get the inner type
        let tendermint_pubkey = TendermintPublicKey::from(pubkey);
        // Get the RIPEMD160(SHA256(pubkey))
        let tendermint_id = TendermintAccountId::from(tendermint_pubkey);
        // Bech32 encoding
        let account_id = AccountId::new(prefix, tendermint_id.as_bytes())?;
        // Hex digest
        let digest = Self::bech32_decode(&account_id)?;
        Ok(CosmosAddress::new(account_id, digest))
    }

    /// Creates a wrapper arround a cosmrs AccountId from a private key byte array
    pub fn from_privkey(priv_key: &[u8], prefix: &str) -> ChainResult<Self> {
        let pubkey = SigningKey::from_slice(priv_key)?.public_key();
        Self::from_pubkey(pubkey, prefix)
    }

    /// Creates a wrapper arround a cosmrs AccountId from a H256 digest
    ///
    /// - digest: H256 digest (hex version of address)
    /// - prefix: Bech32 prefix
    pub fn from_h256(digest: H256, prefix: &str) -> ChainResult<Self> {
        let bytes = digest.as_bytes();
        // Bech32 encoding
        let account_id = AccountId::new(prefix, bytes)?;
        Ok(CosmosAddress::new(account_id, digest))
    }

    fn bech32_decode(account_id: &AccountId) -> ChainResult<H256> {
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

    /// String representation of a cosmos AccountId
    pub fn address(&self) -> String {
        self.account_id.to_string()
    }

    /// H256 digest of the cosmos AccountId
    pub fn digest(&self) -> H256 {
        self.digest
    }
}

impl TryFrom<&CosmosAddress> for H256 {
    type Error = ChainCommunicationError;

    fn try_from(cosmos_address: &CosmosAddress) -> Result<Self, Self::Error> {
        let bytes = cosmos_address.account_id.to_bytes();
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
}

impl FromStr for CosmosAddress {
    type Err = ChainCommunicationError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let account_id = AccountId::from_str(s)?;
        // Temporarily set the digest to a default value.
        // Can implement H256::try_from for AccountId to avoid this.
        let mut cosmos_address = CosmosAddress::new(account_id, Default::default());
        cosmos_address.digest = H256::try_from(&cosmos_address)?;
        Ok(cosmos_address)
    }
}

#[cfg(test)]
pub mod test {
    use hyperlane_core::utils::hex_or_base58_to_h256;

    use super::*;

    #[test]
    fn test_bech32_decode() {
        let addr = "dual1pk99xge6q94qtu3568x3qhp68zzv0mx7za4ct008ks36qhx5tvss3qawfh";
        let cosmos_address = CosmosAddress::from_str(addr).unwrap();
        assert_eq!(
            CosmosAddress::bech32_decode(&cosmos_address.account_id)
                .expect("decoding of a valid address shouldn't panic"),
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
            "neutron1kknekjxg0ear00dky5ykzs8wwp2gz62z9s6aaj"
        );
    }
}

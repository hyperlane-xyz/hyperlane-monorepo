use std::str::FromStr;

use cosmrs::{
    crypto::{secp256k1::SigningKey, PublicKey},
    AccountId,
};
use derive_new::new;
use hyperlane_core::{ChainCommunicationError, ChainResult, Error::Overflow, H256};
use tendermint::account::Id as TendermintAccountId;
use tendermint::public_key::PublicKey as TendermintPublicKey;

use crate::HyperlaneCosmosError;

/// Wrapper around the cosmrs AccountId type that abstracts bech32 encoding
#[derive(new, Debug, Clone)]
pub struct CosmosAddress {
    /// Bech32 encoded cosmos account
    account_id: AccountId,
    /// Hex representation (digest) of cosmos account
    digest: H256,
}

impl CosmosAddress {
    /// Returns a Bitcoin style address: RIPEMD160(SHA256(pubkey))
    /// Source: `<https://github.com/cosmos/cosmos-sdk/blob/177e7f45959215b0b4e85babb7c8264eaceae052/crypto/keys/secp256k1/secp256k1.go#L154>`
    pub fn from_pubkey(pubkey: PublicKey, prefix: &str) -> ChainResult<Self> {
        // Get the inner type
        let tendermint_pubkey = TendermintPublicKey::from(pubkey);
        // Get the RIPEMD160(SHA256(pubkey))
        let tendermint_id = TendermintAccountId::from(tendermint_pubkey);
        // Bech32 encoding
        let account_id = AccountId::new(prefix, tendermint_id.as_bytes())
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        // Hex digest
        let digest = Self::bech32_decode(account_id.clone())?;
        Ok(CosmosAddress::new(account_id, digest))
    }

    /// Creates a wrapper around a cosmrs AccountId from a private key byte array
    pub fn from_privkey(priv_key: &[u8], prefix: &str) -> ChainResult<Self> {
        let pubkey = SigningKey::from_slice(priv_key)
            .map_err(Into::<HyperlaneCosmosError>::into)?
            .public_key();
        Self::from_pubkey(pubkey, prefix)
    }

    /// Creates a wrapper around a cosmrs AccountId from a H256 digest
    ///
    /// - digest: H256 digest (hex representation of address)
    /// - prefix: Bech32 prefix
    /// - byte_count: Number of bytes to truncate the digest to. Cosmos addresses can sometimes
    ///     be less than 32 bytes, so this helps to serialize it in bech32 with the appropriate
    ///     length.
    pub fn from_h256(digest: H256, prefix: &str, byte_count: usize) -> ChainResult<Self> {
        // This is the hex-encoded version of the address
        let untruncated_bytes = digest.as_bytes();

        if byte_count > untruncated_bytes.len() {
            return Err(Overflow.into());
        }

        let remainder_bytes_start = untruncated_bytes.len() - byte_count;
        // Left-truncate the digest to the desired length
        let bytes = &untruncated_bytes[remainder_bytes_start..];

        // Bech32 encode it
        let account_id =
            AccountId::new(prefix, bytes).map_err(Into::<HyperlaneCosmosError>::into)?;
        Ok(CosmosAddress::new(account_id, digest))
    }

    /// Builds a H256 digest from a cosmos AccountId (Bech32 encoding)
    fn bech32_decode(account_id: AccountId) -> ChainResult<H256> {
        // Temporarily set the digest to a default value as a placeholder.
        // Can't implement H256::try_from for AccountId to avoid this.
        let cosmos_address = CosmosAddress::new(account_id, Default::default());
        H256::try_from(&cosmos_address)
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
        // `to_bytes()` decodes the Bech32 into a hex, represented as a byte vec
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
        let account_id = AccountId::from_str(s).map_err(Into::<HyperlaneCosmosError>::into)?;
        let digest = Self::bech32_decode(account_id.clone())?;
        Ok(Self::new(account_id, digest))
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
            cosmos_address.digest,
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

        // Create an address with the same digest & explicitly set the byte count to 20,
        // which should have the same result as the above.
        let digest = addr.digest();
        let addr2 =
            CosmosAddress::from_h256(digest, prefix, 20).expect("Cosmos address creation failed");
        assert_eq!(addr.address(), addr2.address());
    }

    #[test]
    fn test_bech32_encode_from_h256() {
        let hex_key = "0x1b16866227825a5166eb44031cdcf6568b3e80b52f2806e01b89a34dc90ae616";
        let key = hex_or_base58_to_h256(hex_key).unwrap();
        let prefix = "dual";
        let addr =
            CosmosAddress::from_h256(key, prefix, 32).expect("Cosmos address creation failed");
        assert_eq!(
            addr.address(),
            "dual1rvtgvc38sfd9zehtgsp3eh8k269naq949u5qdcqm3x35mjg2uctqfdn3yq"
        );

        // Last 20 bytes only, which is 0x1cdcf6568b3e80b52f2806e01b89a34dc90ae616
        let addr =
            CosmosAddress::from_h256(key, prefix, 20).expect("Cosmos address creation failed");
        assert_eq!(
            addr.address(),
            "dual1rnw0v45t86qt2tegqmsphzdrfhys4esk9ktul7"
        );
    }
}

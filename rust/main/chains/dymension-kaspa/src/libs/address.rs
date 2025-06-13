use std::str::FromStr;

use cosmrs::{
    crypto::{secp256k1::SigningKey, PublicKey},
    AccountId,
};
use derive_new::new;
use hyperlane_core::{
    AccountAddressType, ChainCommunicationError, ChainResult, Error::Overflow, H256,
};

use crate::{HyperlaneKaspaError, KaspaAccountId};

/// Wrapper around the cosmrs AccountId type that abstracts bech32 encoding
#[derive(new, Debug, Clone)]
pub struct KaspaAddress {
    /// Bech32 encoded kaspa account
    account_id: AccountId,
    /// Hex representation (digest) of kaspa account
    digest: H256,
}

impl KaspaAddress {
    /// Creates a wrapper around a cosmrs AccountId from a private key byte array
    pub fn from_privkey(
        priv_key: &[u8],
        prefix: &str,
        account_address_type: &AccountAddressType,
    ) -> ChainResult<Self> {
        let pubkey = SigningKey::from_slice(priv_key)
            .map_err(Into::<HyperlaneKaspaError>::into)?
            .public_key();
        Self::from_pubkey(pubkey, prefix, account_address_type)
    }

    /// Returns an account address calculated from Bech32 encoding
    pub fn from_account_id(account_id: AccountId) -> ChainResult<Self> {
        // Hex digest
        let digest = H256::try_from(&KaspaAccountId::new(&account_id))?;
        Ok(KaspaAddress::new(account_id, digest))
    }

    /// Creates a wrapper around a cosmrs AccountId from a H256 digest
    ///
    /// - digest: H256 digest (hex representation of address)
    /// - prefix: Bech32 prefix
    /// - byte_count: Number of bytes to truncate the digest to. Kaspa addresses can sometimes
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
            AccountId::new(prefix, bytes).map_err(Into::<HyperlaneKaspaError>::into)?;
        Ok(KaspaAddress::new(account_id, digest))
    }

    /// String representation of a kaspa AccountId
    pub fn address(&self) -> String {
        self.account_id.to_string()
    }

    /// H256 digest of the kaspa AccountId
    pub fn digest(&self) -> H256 {
        self.digest
    }

    /// Calculates an account address depending on prefix and account address type
    fn from_pubkey(
        pubkey: PublicKey,
        prefix: &str,
        account_address_type: &AccountAddressType,
    ) -> ChainResult<Self> {
        let account_id =
            KaspaAccountId::account_id_from_pubkey(pubkey, prefix, account_address_type)?;
        Self::from_account_id(account_id)
    }
}

impl TryFrom<&KaspaAddress> for H256 {
    type Error = ChainCommunicationError;

    fn try_from(kaspa_address: &KaspaAddress) -> Result<Self, Self::Error> {
        H256::try_from(KaspaAccountId::new(&kaspa_address.account_id))
            .map_err(Into::<ChainCommunicationError>::into)
    }
}

impl FromStr for KaspaAddress {
    type Err = ChainCommunicationError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let account_id = AccountId::from_str(s).map_err(Into::<HyperlaneKaspaError>::into)?;
        let digest = KaspaAccountId::new(&account_id).try_into()?;
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
        let kaspa_address = KaspaAddress::from_str(addr).unwrap();
        assert_eq!(
            kaspa_address.digest,
            H256::from_str("0d8a53233a016a05f234d1cd105c3a3884c7ecde176b85bde7b423a05cd45b21")
                .unwrap()
        );
    }

    #[test]
    fn test_bech32_decode_from_kaspa_key() {
        let hex_key = "0x5486418967eabc770b0fcb995f7ef6d9a72f7fc195531ef76c5109f44f51af26";
        let key = hex_or_base58_to_h256(hex_key).unwrap();
        let prefix = "neutron";
        let addr = KaspaAddress::from_privkey(key.as_bytes(), prefix, &AccountAddressType::Bitcoin)
            .expect("Kaspa address creation failed");
        assert_eq!(
            addr.address(),
            "neutron1kknekjxg0ear00dky5ykzs8wwp2gz62z9s6aaj"
        );

        // Create an address with the same digest & explicitly set the byte count to 20,
        // which should have the same result as the above.
        let digest = addr.digest();
        let addr2 =
            KaspaAddress::from_h256(digest, prefix, 20).expect("Kaspa address creation failed");
        assert_eq!(addr.address(), addr2.address());
    }

    #[test]
    fn test_bech32_encode_from_h256() {
        let hex_key = "0x1b16866227825a5166eb44031cdcf6568b3e80b52f2806e01b89a34dc90ae616";
        let key = hex_or_base58_to_h256(hex_key).unwrap();
        let prefix = "dual";
        let addr = KaspaAddress::from_h256(key, prefix, 32).expect("Kaspa address creation failed");
        assert_eq!(
            addr.address(),
            "dual1rvtgvc38sfd9zehtgsp3eh8k269naq949u5qdcqm3x35mjg2uctqfdn3yq"
        );

        // Last 20 bytes only, which is 0x1cdcf6568b3e80b52f2806e01b89a34dc90ae616
        let addr = KaspaAddress::from_h256(key, prefix, 20).expect("Kaspa address creation failed");
        assert_eq!(
            addr.address(),
            "dual1rnw0v45t86qt2tegqmsphzdrfhys4esk9ktul7"
        );
    }
}

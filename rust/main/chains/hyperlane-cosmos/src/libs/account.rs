use cosmrs::{crypto::PublicKey, AccountId};
use hyperlane_cosmwasm_interface::types::keccak256_hash;
use tendermint::account::Id as TendermintAccountId;
use tendermint::public_key::PublicKey as TendermintPublicKey;

use crypto::decompress_public_key;
use hyperlane_core::Error::Overflow;
use hyperlane_core::{AccountAddressType, ChainCommunicationError, ChainResult, H256};

use crate::HyperlaneCosmosError;

pub(crate) struct CosmosAccountId<'a> {
    account_id: &'a AccountId,
}

impl<'a> CosmosAccountId<'a> {
    pub fn new(account_id: &'a AccountId) -> Self {
        Self { account_id }
    }

    /// Calculate AccountId from public key depending on provided prefix
    pub fn account_id_from_pubkey(
        pub_key: PublicKey,
        prefix: &str,
        account_address_type: &AccountAddressType,
    ) -> ChainResult<AccountId> {
        match account_address_type {
            AccountAddressType::Bitcoin => Self::bitcoin_style(pub_key, prefix),
            AccountAddressType::Ethereum => Self::ethereum_style(pub_key, prefix),
        }
    }

    /// Returns a Bitcoin style address: RIPEMD160(SHA256(pubkey))
    /// Source: `<https://github.com/cosmos/cosmos-sdk/blob/177e7f45959215b0b4e85babb7c8264eaceae052/crypto/keys/secp256k1/secp256k1.go#L154>`
    fn bitcoin_style(pub_key: PublicKey, prefix: &str) -> ChainResult<AccountId> {
        // Get the inner type
        let tendermint_pub_key = TendermintPublicKey::from(pub_key);
        // Get the RIPEMD160(SHA256(pub_key))
        let tendermint_id = TendermintAccountId::from(tendermint_pub_key);
        // Bech32 encoding
        let account_id = AccountId::new(prefix, tendermint_id.as_bytes())
            .map_err(Box::new)
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok(account_id)
    }

    /// Returns an Ethereum style address: KECCAK256(pubkey)[20]
    /// Parameter `pub_key` is a compressed public key.
    fn ethereum_style(pub_key: PublicKey, prefix: &str) -> ChainResult<AccountId> {
        let decompressed_public_key = decompress_public_key(&pub_key.to_bytes())
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        let hash = keccak256_hash(&decompressed_public_key[1..]);

        let mut bytes = [0u8; 20];
        bytes.copy_from_slice(&hash.as_slice()[12..]);

        let account_id = AccountId::new(prefix, bytes.as_slice())
            .map_err(Box::new)
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok(account_id)
    }
}

impl TryFrom<&CosmosAccountId<'_>> for H256 {
    type Error = HyperlaneCosmosError;

    /// Builds a H256 digest from a cosmos AccountId (Bech32 encoding)
    fn try_from(account_id: &CosmosAccountId) -> Result<Self, Self::Error> {
        let bytes = account_id.account_id.to_bytes();
        let h256_len = H256::len_bytes();
        let Some(start_point) = h256_len.checked_sub(bytes.len()) else {
            // input is too large to fit in a H256
            let msg = "account address is too large to fit it a H256";
            return Err(HyperlaneCosmosError::AddressError(msg.to_owned()));
        };
        let mut empty_hash = H256::default();
        let result = empty_hash.as_bytes_mut();
        result[start_point..].copy_from_slice(bytes.as_slice());
        Ok(H256::from_slice(result))
    }
}

impl TryFrom<CosmosAccountId<'_>> for H256 {
    type Error = HyperlaneCosmosError;

    /// Builds a H256 digest from a cosmos AccountId (Bech32 encoding)
    fn try_from(account_id: CosmosAccountId) -> Result<Self, Self::Error> {
        (&account_id).try_into()
    }
}

#[cfg(test)]
mod tests;

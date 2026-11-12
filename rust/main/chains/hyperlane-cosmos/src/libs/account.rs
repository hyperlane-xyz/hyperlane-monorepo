use cometbft::account::Id as TendermintAccountId;
use cometbft::public_key::PublicKey as TendermintPublicKey;
use cosmrs::{
    crypto::{LegacyAminoMultisig, PublicKey},
    AccountId,
};
use hyperlane_cosmwasm_interface::types::keccak256_hash;
use protobuf::CodedOutputStream;
use sha2::{Digest, Sha256};

use crypto::decompress_public_key;
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

    /// Legacy multisig accounts use SHA256(Amino(pubkey))[..20], not the
    /// single secp256k1 key's RIPEMD160 address derivation.
    /// Source: <https://github.com/cosmos/cosmos-sdk/blob/v0.50.13/crypto/keys/multisig/multisig.go>
    pub fn account_id_from_multisig(
        key: &LegacyAminoMultisig,
        prefix: &str,
    ) -> ChainResult<AccountId> {
        if key.threshold == 0 || u64::from(key.threshold) > key.public_keys.len() as u64 {
            return Err(HyperlaneCosmosError::PublicKeyError(
                "invalid multisig threshold".to_owned(),
            )
            .into());
        }

        // Amino type prefixes, including the fixed-length member key size.
        // https://github.com/cosmos/cosmjs/blob/v0.36.0/packages/amino/src/encoding.ts
        const MULTISIG_PREFIX: [u8; 4] = [0x22, 0xc1, 0xf7, 0xe2];
        const SECP256K1_PREFIX: [u8; 5] = [0xeb, 0x5a, 0xe9, 0x87, 0x21];
        const ED25519_PREFIX: [u8; 5] = [0x16, 0x24, 0xde, 0x64, 0x20];
        let mut amino = MULTISIG_PREFIX.to_vec();
        {
            let mut output = CodedOutputStream::vec(&mut amino);
            output
                .write_uint32(1, key.threshold)
                .map_err(HyperlaneCosmosError::from)?;
            for member in &key.public_keys {
                let prefix = match member.type_url() {
                    PublicKey::SECP256K1_TYPE_URL => SECP256K1_PREFIX,
                    PublicKey::ED25519_TYPE_URL => ED25519_PREFIX,
                    other => {
                        return Err(HyperlaneCosmosError::PublicKeyError(format!(
                            "unsupported multisig member key: {other}"
                        ))
                        .into())
                    }
                };
                let mut encoded = prefix.to_vec();
                encoded.extend(member.to_bytes());
                output
                    .write_bytes(2, &encoded)
                    .map_err(HyperlaneCosmosError::from)?;
            }
            output.flush().map_err(HyperlaneCosmosError::from)?;
        }
        let hash = Sha256::digest(amino);
        AccountId::new(prefix, &hash[..20])
            .map_err(Box::new)
            .map_err(Into::<HyperlaneCosmosError>::into)
            .map_err(Into::into)
    }

    /// Returns a Bitcoin style address: RIPEMD160(SHA256(pubkey))
    /// Source: `<https://github.com/cosmos/cosmos-sdk/blob/177e7f45959215b0b4e85babb7c8264eaceae052/crypto/keys/secp256k1/secp256k1.go#L154>`
    fn bitcoin_style(pub_key: PublicKey, prefix: &str) -> ChainResult<AccountId> {
        // Get the inner type
        let pub_key =
            cometbft::PublicKey::from_raw_secp256k1(&pub_key.to_bytes()).ok_or_else(|| {
                ChainCommunicationError::ParseError {
                    msg: "Failed to parse to secp256k1 key".into(),
                }
            })?;
        // Get the RIPEMD160(SHA256(pub_key))
        let id_account = cometbft::account::Id::from(pub_key);
        // Bech32 encoding
        let account_id = AccountId::new(prefix, id_account.as_bytes())
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

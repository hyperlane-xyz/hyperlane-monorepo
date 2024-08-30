use cosmrs::AccountId;

use hyperlane_core::Error::Overflow;
use hyperlane_core::{ChainCommunicationError, H256};

pub(crate) struct CosmosAccountId<'a> {
    account_id: &'a AccountId,
}

impl<'a> CosmosAccountId<'a> {
    pub fn new(account_id: &'a AccountId) -> Self {
        Self { account_id }
    }
}

impl TryFrom<&CosmosAccountId<'_>> for H256 {
    type Error = ChainCommunicationError;

    /// Builds a H256 digest from a cosmos AccountId (Bech32 encoding)
    fn try_from(account_id: &CosmosAccountId) -> Result<Self, Self::Error> {
        let bytes = account_id.account_id.to_bytes();
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

impl TryFrom<CosmosAccountId<'_>> for H256 {
    type Error = ChainCommunicationError;

    /// Builds a H256 digest from a cosmos AccountId (Bech32 encoding)
    fn try_from(account_id: CosmosAccountId) -> Result<Self, Self::Error> {
        (&account_id).try_into()
    }
}

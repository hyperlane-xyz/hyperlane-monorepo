use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{instruction::AccountMeta, pubkey::Pubkey};

/// A borsh-serializable version of `AccountMeta`.
#[derive(Debug, BorshSerialize, BorshDeserialize)]
pub struct SerializableAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

impl From<AccountMeta> for SerializableAccountMeta {
    fn from(account_meta: AccountMeta) -> Self {
        Self {
            pubkey: account_meta.pubkey,
            is_signer: account_meta.is_signer,
            is_writable: account_meta.is_writable,
        }
    }
}

impl From<SerializableAccountMeta> for AccountMeta {
    fn from(serializable_account_meta: SerializableAccountMeta) -> Self {
        Self {
            pubkey: serializable_account_meta.pubkey,
            is_signer: serializable_account_meta.is_signer,
            is_writable: serializable_account_meta.is_writable,
        }
    }
}

/// A ridiculous workaround for https://github.com/solana-labs/solana/issues/31391,
/// which is a bug where if a simulated transaction's return data ends with zero byte(s),
/// they end up being incorrectly truncated.
/// As a workaround, we can (de)serialize data with a trailing non-zero byte.
#[derive(Debug, BorshSerialize, BorshDeserialize)]
pub struct SimulationReturnData<T>
where
    T: BorshSerialize + BorshDeserialize,
{
    pub return_data: T,
    trailing_byte: u8,
}

impl<T> SimulationReturnData<T>
where
    T: BorshSerialize + BorshDeserialize,
{
    pub fn new(return_data: T) -> Self {
        Self {
            return_data,
            trailing_byte: u8::MAX,
        }
    }
}

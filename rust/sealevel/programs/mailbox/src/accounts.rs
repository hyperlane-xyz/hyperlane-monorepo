//! Hyperlane Sealevel Mailbox data account layouts.

use std::{collections::HashSet, str::FromStr as _};

use hyperlane_core::{accumulator::incremental::IncrementalMerkle as MerkleTree, H256};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    pubkey::Pubkey,
    program_error::ProgramError,
    // Note: Not convinced program_pack::{IsInitialized, Pack} add value here.
};

use crate::{DEFAULT_ISM, DEFAULT_ISM_ACCOUNTS, error::Error};

pub trait Data: BorshDeserialize + BorshSerialize + Default {}
impl<T> Data for T where T: BorshDeserialize + BorshSerialize + Default {}

/// Account data structure wrapper type that handles initialization and (de)serialization.
///
/// (De)serialization is done with borsh and the "on-disk" format is as follows:
/// {
///     initialized: bool,
///     data: T,
/// }
#[derive(Debug, Default)]
pub struct AccountData<T> {
    data: T,
}

impl<T> From<T> for AccountData<T> {
    fn from(data: T) -> Self {
        Self {
            data
        }
    }
}

impl<T> AccountData<T>
where
    T: Data
{
    pub fn into_inner(self) -> T {
        self.data
    }

    pub fn fetch(buf: &mut &[u8]) -> Result<Self, ProgramError> {
        // Account data is zero initialized.
        let initialized = bool::deserialize(buf)?;
        let data = if initialized {
            T::deserialize(buf)?
        } else {
            T::default()
        };
        Ok(Self {
            data
        })
    }

    // Optimisically write then realloc on failure.
    // If we serialize and calculate len before realloc we will waste heap space as there is no
    // free(). Tradeoff between heap usage and compute budget.
    pub fn store<'a>(
        &self,
        account: &AccountInfo<'a>,
        allow_realloc: bool,
    ) -> Result<(), ProgramError> {
        if !account.is_writable || account.executable {
            return Err(ProgramError::from(Error::AccountReadOnly));
        }
        let realloc_increment = 1024;
        loop {
            let mut writer = &mut account.data.borrow_mut()[..];
            match true.serialize(&mut writer).and_then(|_| self.data.serialize(&mut writer)) {
                Ok(_) => break,
                Err(err) => match err.kind() {
                    std::io::ErrorKind::WriteZero => if !allow_realloc {
                        return Err(ProgramError::BorshIoError(err.to_string()));
                    },
                    _ => return Err(ProgramError::BorshIoError(err.to_string())),
                },
            };
            let data_len = account.data.borrow().len() + realloc_increment;
            if cfg!(target_os = "solana") {
                account.realloc(data_len, false)?;
            } else {
                panic!("realloc() is only supported on the SVM");
            }
        }
        Ok(())
    }
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct Config {
    pub ism: Pubkey,
    pub ism_accounts: Vec<Pubkey>,
    pub local_domain: u32,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            // FIXME can declare_id!() or similar be used for these to compute at compile time?
            ism: Pubkey::from_str(DEFAULT_ISM).unwrap(),
            ism_accounts: DEFAULT_ISM_ACCOUNTS
                .into_iter()
                .map(|account| Pubkey::from_str(account).unwrap())
                .collect(),
            // FIXME there isn't a valid default value here... We need to ensure that the account
            // is initialized when created or bake local domain into the contract?
            local_domain: u32::MAX,
        }
    }
}
pub type ConfigAccount = AccountData<Config>;
pub const CONFIG_ACCOUNT_SIZE: usize = 1024;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct Inbox {
    // Note: 10MB account limit is around ~300k entries.
    pub delivered: HashSet<H256>,
}
pub type InboxAccount = AccountData<Inbox>;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct Outbox {
    pub tree: MerkleTree,
}
pub type OutboxAccount = AccountData<Outbox>;

use access_control::AccessControl;
use account_utils::AccountData;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// The storage PDA account data.
/// `modules` is dynamic so SizedData is not implemented; use allow_realloc=true when storing.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct StorageData {
    pub bump_seed: u8,
    pub owner: Option<Pubkey>,
    pub threshold: u8,
    pub modules: Vec<Pubkey>,
}

impl AccessControl for StorageData {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

pub type StorageAccount = AccountData<StorageData>;

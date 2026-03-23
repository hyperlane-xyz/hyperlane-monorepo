use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// The storage PDA account data.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct StorageData {
    pub bump_seed: u8,
    pub owner: Option<Pubkey>,
    pub relayer: Pubkey,
}

impl SizedData for StorageData {
    fn size(&self) -> usize {
        // bump_seed: 1
        // owner: 1 (Option variant) + 32 (Pubkey) = 33
        // relayer: 32
        1 + 33 + 32
    }
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

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_storage_data_size() {
        let data = StorageData {
            bump_seed: 0,
            owner: Some(Pubkey::new_unique()),
            relayer: Pubkey::new_unique(),
        };
        let serialized = borsh::to_vec(&data).unwrap();
        assert_eq!(data.size(), serialized.len());
    }
}

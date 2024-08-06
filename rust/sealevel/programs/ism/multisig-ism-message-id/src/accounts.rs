use borsh::{BorshDeserialize, BorshSerialize};

use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::instruction::ValidatorsAndThreshold;

/// The data of a "domain data" PDA account.
/// One of these exists for each domain that's been enrolled.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct DomainData {
    pub bump_seed: u8,
    pub validators_and_threshold: ValidatorsAndThreshold,
}

pub type DomainDataAccount = AccountData<DomainData>;

/// The data of the access control PDA account.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct AccessControlData {
    pub bump_seed: u8,
    pub owner: Option<Pubkey>,
}

impl SizedData for AccessControlData {
    fn size(&self) -> usize {
        // 1 byte bump seed + 1 byte Option variant + 32 byte owner pubkey
        1 + 1 + 32
    }
}

impl AccessControl for AccessControlData {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

pub type AccessControlAccount = AccountData<AccessControlData>;

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_access_control_data_size() {
        let data = AccessControlData {
            bump_seed: 0,
            owner: Some(Pubkey::new_unique()),
        };
        let serialized = data.try_to_vec().unwrap();
        assert_eq!(data.size(), serialized.len());
    }
}

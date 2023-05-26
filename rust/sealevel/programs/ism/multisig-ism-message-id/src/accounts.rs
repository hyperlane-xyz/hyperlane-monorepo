use borsh::{BorshDeserialize, BorshSerialize};

use hyperlane_sealevel_mailbox::accounts::{AccountData, SizedData};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::{error::Error, instruction::ValidatorsAndThreshold};

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
    pub owner: Pubkey,
}

impl SizedData for AccessControlData {
    fn size(&self) -> usize {
        // 1 byte bump seed + 32 byte owner pubkey
        1 + 32
    }
}

impl AccessControlData {
    pub fn ensure_owner_signer(&self, maybe_owner: &AccountInfo) -> Result<(), ProgramError> {
        if !maybe_owner.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        if self.owner != *maybe_owner.key {
            return Err(Error::AccountNotOwner.into());
        }
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
            owner: Pubkey::new_unique(),
        };
        let serialized = data.try_to_vec().unwrap();
        assert_eq!(data.size(), serialized.len());
    }
}

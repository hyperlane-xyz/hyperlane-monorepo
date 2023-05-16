use borsh::{BorshDeserialize, BorshSerialize};

use hyperlane_sealevel_mailbox::accounts::{
    AccountData,
    SizedData,
};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::{error::Error, instruction::ValidatorsAndThreshold};

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct DomainData {
    pub bump_seed: u8,
    pub validators_and_threshold: ValidatorsAndThreshold,
}

pub type DomainDataAccount = AccountData<DomainData>;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct AccessControlData {
    pub bump_seed: u8,
    pub owner: Pubkey,
}

impl SizedData for AccessControlData {
    fn size() -> usize {
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

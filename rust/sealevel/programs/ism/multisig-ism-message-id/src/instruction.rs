use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H160;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_program,
};

use std::collections::HashSet;

use crate::{access_control_pda_seeds, domain_data_pda_seeds, error::Error};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    ///
    /// Accounts:
    /// 0. `[signer]` The new owner and payer of the access control PDA.
    /// 1. `[writable]` The access control PDA account.
    /// 2. `[executable]` The system program account.
    Initialize,
    /// Input: domain ID, validators, & threshold to set.
    ///
    /// Accounts:
    /// 0. `[signer]` The access control owner and payer of the domain PDA.
    /// 1. `[]` The access control PDA account.
    /// 2. `[writable]` The PDA relating to the provided domain.
    /// 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
    SetValidatorsAndThreshold(Domained<ValidatorsAndThreshold>),
    /// Gets the owner from the access control data.
    ///
    /// Accounts:
    /// 0. `[]` The access control PDA account.
    GetOwner,
    /// Sets the owner in the access control data.
    ///
    /// Accounts:
    /// 0. `[signer]` The current access control owner.
    /// 1. `[]` The access control PDA account.
    TransferOwnership(Option<Pubkey>),
}

impl DiscriminatorData for Instruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

impl TryFrom<&[u8]> for Instruction {
    type Error = ProgramError;

    fn try_from(data: &[u8]) -> Result<Self, Self::Error> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

/// Holds data relating to a specific domain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct Domained<T> {
    pub domain: u32,
    pub data: T,
}

/// A configuration of a validator set and threshold.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default, Clone)]
pub struct ValidatorsAndThreshold {
    pub validators: Vec<H160>,
    pub threshold: u8,
}

impl ValidatorsAndThreshold {
    /// Validates the validator set and threshold.
    /// Returns an error if the set is empty, the threshold is zero, the threshold exceeds the
    /// number of validators, or if the validator set has any duplicates.
    pub fn validate(&self) -> Result<(), ProgramError> {
        let validators_len = self.validators.len();

        // Ensure the threshold is non-zero and doesn't exceed the number of validators.
        if self.threshold == 0 || self.threshold as usize > validators_len {
            return Err(Error::InvalidValidatorsAndThreshold.into());
        }

        // If the set has any duplicates, error.
        let mut set = HashSet::with_capacity(validators_len);
        for validator in &self.validators {
            if !set.insert(validator) {
                return Err(Error::InvalidValidatorsAndThreshold.into());
            }
        }

        Ok(())
    }
}

pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (access_control_pda_key, _access_control_pda_bump) =
        Pubkey::try_find_program_address(access_control_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::Initialize;

    // Accounts:
    // 0. `[signer]` The new owner and payer of the access control PDA.
    // 1. `[writable]` The access control PDA account.
    // 2. `[executable]` The system program account.
    let accounts = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new(access_control_pda_key, false),
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Creates a TransferOwnership instruction.
pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (access_control_pda_key, _access_control_pda_bump) =
        Pubkey::try_find_program_address(access_control_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    // 0. `[signer]` The current access control owner.
    // 1. `[writeable]` The access control PDA account.
    let instruction = SolanaInstruction {
        program_id,
        data: Instruction::TransferOwnership(new_owner).encode()?,
        accounts: vec![
            AccountMeta::new(owner_payer, true),
            AccountMeta::new(access_control_pda_key, false),
        ],
    };
    Ok(instruction)
}

/// Greats a SetValidatorsAndThreshold instruction.
pub fn set_validators_and_threshold_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    domain: u32,
    validators_and_threshold: ValidatorsAndThreshold,
) -> Result<SolanaInstruction, ProgramError> {
    let (access_control_pda_key, _access_control_pda_bump) =
        Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

    let (domain_data_pda_key, _domain_data_pda_bump) =
        Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);

    let ixn = Instruction::SetValidatorsAndThreshold(Domained {
        domain,
        data: validators_and_threshold.clone(),
    });

    // Accounts:
    // 0. `[signer]` The access control owner and payer of the domain PDA.
    // 1. `[]` The access control PDA account.
    // 2. `[writable]` The PDA relating to the provided domain.
    // 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
    let accounts = vec![
        AccountMeta::new(owner_payer, true),
        AccountMeta::new_readonly(access_control_pda_key, false),
        AccountMeta::new(domain_data_pda_key, false),
        AccountMeta::new_readonly(system_program::id(), false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode().unwrap(),
        accounts,
    };
    Ok(instruction)
}

#[cfg(test)]
mod test {
    use super::*;

    use hyperlane_core::H160;

    #[test]
    fn test_validators_and_threshold_validate_success() {
        let v = ValidatorsAndThreshold {
            validators: vec![H160::zero(), H160::random()],
            threshold: 1,
        };
        assert!(v.validate().is_ok());

        // Threshold equals validator set size
        let v = ValidatorsAndThreshold {
            validators: vec![H160::zero(), H160::random()],
            threshold: 2,
        };
        assert!(v.validate().is_ok());
    }

    #[test]
    fn test_validators_and_threshold_validate_errors() {
        // Threshold 0 and validators empty
        let v = ValidatorsAndThreshold {
            validators: vec![],
            threshold: 0,
        };
        assert_eq!(
            v.validate().unwrap_err(),
            Error::InvalidValidatorsAndThreshold.into()
        );

        // Threshold 0 and validators not empty
        let v = ValidatorsAndThreshold {
            validators: vec![H160::zero()],
            threshold: 0,
        };
        assert_eq!(
            v.validate().unwrap_err(),
            Error::InvalidValidatorsAndThreshold.into()
        );

        // Threshold exceeds validator set size
        let v = ValidatorsAndThreshold {
            validators: vec![H160::zero()],
            threshold: 2,
        };
        assert_eq!(
            v.validate().unwrap_err(),
            Error::InvalidValidatorsAndThreshold.into()
        );

        // Validator set has duplicates
        let v = ValidatorsAndThreshold {
            validators: vec![H160::zero(), H160::zero()],
            threshold: 2,
        };
        assert_eq!(
            v.validate().unwrap_err(),
            Error::InvalidValidatorsAndThreshold.into()
        );
    }
}

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H160;
use hyperlane_sealevel_mailbox::instruction::IsmVerify;
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use std::collections::HashSet;

use crate::error::Error;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Verifies a message.
    IsmVerify(IsmVerify),
    /// Gets the type of ISM
    IsmType,
    /// Initializes the program.
    Initialize,
    /// Input: domain ID to query.
    GetValidatorsAndThreshold(u32),
    /// Input: domain ID, validators, & threshold to set.
    SetValidatorsAndThreshold(Domained<ValidatorsAndThreshold>),
    /// Gets the owner from the access control data.
    GetOwner(),
    /// Sets the owner in the access control data.
    SetOwner(Pubkey),
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

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H160;
use solana_program::{keccak, program_error::ProgramError, pubkey::Pubkey};

/// Instructions for the ValidatorAnnounce program.
#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug, Clone)]
pub enum Instruction {
    /// Initializes the program.
    Init(InitInstruction),
    /// Announces a validator's storage location.
    Announce(AnnounceInstruction),
}

impl Instruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        self.try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))
    }
}

/// Init data.
#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug, Clone)]
pub struct InitInstruction {
    pub mailbox: Pubkey,
    pub local_domain: u32,
}

/// Announcement data.
#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug, Clone)]
pub struct AnnounceInstruction {
    pub validator: H160,
    pub storage_location: String,
    pub signature: Vec<u8>,
}

impl AnnounceInstruction {
    pub fn replay_id(&self) -> [u8; 32] {
        let mut hasher = keccak::Hasher::default();
        hasher.hash(self.validator.as_bytes());
        hasher.hash(self.storage_location.as_bytes());
        hasher.result().to_bytes()
    }
}

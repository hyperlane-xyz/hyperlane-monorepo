use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H160;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    keccak,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::validator_announce_pda_seeds;

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

pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    mailbox_program_id: Pubkey,
    local_domain: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let (validator_announce_account, _validator_announce_bump) =
        Pubkey::try_find_program_address(validator_announce_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::Init(InitInstruction {
        mailbox: mailbox_program_id,
        local_domain,
    });

    // Accounts:
    // 0. [signer] The payer.
    // 1. [executable] The system program.
    // 2. [writable] The ValidatorAnnounce PDA account.
    let accounts = vec![
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new(validator_announce_account, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.into_instruction_data()?,
        accounts,
    };

    Ok(instruction)
}

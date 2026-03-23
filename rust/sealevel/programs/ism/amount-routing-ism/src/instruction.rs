use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::storage_pda_seeds;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    ///
    /// Accounts:
    /// 0. `[signer]` The new owner and payer of the storage PDA.
    /// 1. `[writable]` The storage PDA account.
    /// 2. `[executable]` The system program account.
    Initialize(ConfigData),
    /// Updates threshold, lower_ism, and upper_ism. Owner only.
    ///
    /// Accounts:
    /// 0. `[signer]` The owner.
    /// 1. `[writable]` The storage PDA account.
    SetConfig(ConfigData),
    /// Gets the owner. Returns as return data.
    ///
    /// Accounts:
    /// 0. `[]` The storage PDA account.
    GetOwner,
    /// Transfers ownership.
    ///
    /// Accounts:
    /// 0. `[signer]` The current owner.
    /// 1. `[writable]` The storage PDA account.
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

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct ConfigData {
    pub threshold: u64,
    pub lower_ism: Pubkey,
    pub upper_ism: Pubkey,
}

pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    config: ConfigData,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    let accounts = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new(storage_pda_key, false),
        AccountMeta::new_readonly(system_program::ID, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::Initialize(config).encode()?,
        accounts,
    })
}

pub fn set_config_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    config: ConfigData,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), &program_id);

    let accounts = vec![
        AccountMeta::new(owner, true),
        AccountMeta::new(storage_pda_key, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::SetConfig(config).encode()?,
        accounts,
    })
}

pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), &program_id);

    let accounts = vec![
        AccountMeta::new(owner, true),
        AccountMeta::new(storage_pda_key, false),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::TransferOwnership(new_owner).encode()?,
        accounts,
    })
}

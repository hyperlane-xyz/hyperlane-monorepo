use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{accounts::IsmNode, storage_pda_seeds};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program, creating the storage PDA.
    ///
    /// Accounts:
    /// 0. `[signer]` The new owner and payer.
    /// 1. `[writable]` The storage PDA account.
    /// 2. `[executable]` The system program.
    Initialize(IsmNode),

    /// Replaces the full ISM config tree. Owner-gated.
    ///
    /// Accounts:
    /// 0. `[signer]` The owner.
    /// 1. `[writable]` The storage PDA account.
    /// 2. `[executable]` The system program (required for realloc).
    UpdateConfig(IsmNode),

    /// Gets the owner from the storage PDA.
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

    /// Returns the [`MetadataSpec`] for the given message as return data.
    ///
    /// Resolves Routing/AmountRouting inline so the relayer receives a flat spec.
    ///
    /// Accounts:
    /// 0. `[]` The storage PDA account.
    GetMetadataSpec(
        /// Raw-encoded [`HyperlaneMessage`].
        Vec<u8>,
    ),

    /// Allocates (or resets) a staging buffer for a chunked config update.
    ///
    /// Must be called before `WriteConfigChunk`. If a pending update already
    /// exists it is discarded and replaced with a fresh buffer.
    ///
    /// Accounts:
    /// 0. `[signer]`     The owner.
    /// 1. `[writable]`   The storage PDA account.
    /// 2. `[executable]` The system program (required for PDA realloc).
    BeginConfigUpdate(u32),

    /// Writes a byte slice into the staging buffer at the given offset.
    ///
    /// May be called any number of times; chunks may overlap (last write wins).
    /// Does not realloc — space was pre-allocated by `BeginConfigUpdate`.
    ///
    /// Accounts:
    /// 0. `[signer]`   The owner.
    /// 1. `[writable]` The storage PDA account.
    WriteConfigChunk { offset: u32, data: Vec<u8> },

    /// Deserialises the staging buffer as an `IsmNode`, validates it, normalises
    /// mutable state fields, and stores it as the new `root`. Clears the staging
    /// buffer and reallocates the PDA back down to trim the pending space.
    ///
    /// Accounts:
    /// 0. `[signer]`     The owner.
    /// 1. `[writable]`   The storage PDA account.
    /// 2. `[executable]` The system program (required for PDA realloc).
    CommitConfigUpdate,

    /// Discards the staging buffer without committing. Reallocates the PDA to
    /// trim the pending space. Safe to call even if no update is in progress
    /// (no-op in that case).
    ///
    /// Accounts:
    /// 0. `[signer]`     The owner.
    /// 1. `[writable]`   The storage PDA account.
    /// 2. `[executable]` The system program (required for PDA realloc).
    AbortConfigUpdate,
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

/// Creates an Initialize instruction.
pub fn initialize_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    root: IsmNode,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::Initialize(root).encode()?,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(storage_pda_key, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    })
}

/// Creates an UpdateConfig instruction.
pub fn update_config_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    root: IsmNode,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::UpdateConfig(root).encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    })
}

/// Creates a GetMetadataSpec instruction.
pub fn get_metadata_spec_instruction(
    program_id: Pubkey,
    message_bytes: Vec<u8>,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::GetMetadataSpec(message_bytes).encode()?,
        accounts: vec![AccountMeta::new_readonly(storage_pda_key, false)],
    })
}

/// Creates a BeginConfigUpdate instruction.
pub fn begin_config_update_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    total_len: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::BeginConfigUpdate(total_len).encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    })
}

/// Creates a WriteConfigChunk instruction.
pub fn write_config_chunk_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    offset: u32,
    data: Vec<u8>,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::WriteConfigChunk { offset, data }.encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
        ],
    })
}

/// Creates a CommitConfigUpdate instruction.
pub fn commit_config_update_instruction(
    program_id: Pubkey,
    owner: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::CommitConfigUpdate.encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    })
}

/// Creates an AbortConfigUpdate instruction.
pub fn abort_config_update_instruction(
    program_id: Pubkey,
    owner: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::AbortConfigUpdate.encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    })
}

/// Creates a TransferOwnership instruction.
pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::TransferOwnership(new_owner).encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
        ],
    })
}

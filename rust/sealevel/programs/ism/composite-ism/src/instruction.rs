use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyMetadataSpecInstruction,
};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{derive_domain_pda, IsmNode},
    storage_pda_seeds,
};

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
    /// 0. `[signer]`     The owner (also payer for any rent top-up).
    /// 1. `[writable]`   The storage PDA account.
    /// 2. `[executable]` The system program.
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

    /// Creates or updates the ISM for a specific origin domain within a
    /// `RoutingPda` routing table. If the domain PDA does not exist it is
    /// created; if it already exists it is updated (realloc as needed).
    ///
    /// Validates the ISM and disallows `RateLimited` nodes (writeback not
    /// supported for domain PDAs).
    ///
    /// Accounts:
    /// 0. `[signer]`     The owner (must match the VAM PDA owner).
    /// 1. `[]`           The VAM storage PDA (ownership check).
    /// 2. `[writable]`   The domain PDA.
    /// 3. `[executable]` The system program.
    SetDomainIsm { domain: u32, ism: IsmNode },

    /// Closes a domain PDA, returning rent to the owner.
    ///
    /// Accounts:
    /// 0. `[signer]`   The owner.
    /// 1. `[]`         The VAM storage PDA (ownership check).
    /// 2. `[writable]` The domain PDA.
    RemoveDomainIsm { domain: u32 },

    /// Sets every `Pausable` node in the ISM tree to `paused: true`. Owner-gated.
    ///
    /// Accounts:
    /// 0. `[signer]`   The owner.
    /// 1. `[writable]` The storage PDA.
    Pause,

    /// Sets every `Pausable` node in the ISM tree to `paused: false`. Owner-gated.
    ///
    /// Accounts:
    /// 0. `[signer]`   The owner.
    /// 1. `[writable]` The storage PDA.
    Unpause,
}

impl DiscriminatorData for Instruction {
    // `DiscriminatorDecode::decode` (blanket impl) checks this prefix before
    // deserializing, so every call to `Instruction::decode` is discriminator-guarded.
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
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

/// Creates a VerifyMetadataSpec instruction.
pub fn verify_metadata_spec_instruction(
    program_id: Pubkey,
    message_bytes: Vec<u8>,
    domain_pdas: Vec<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    let mut accounts = vec![AccountMeta::new_readonly(storage_pda_key, false)];
    for pda in domain_pdas {
        accounts.push(AccountMeta::new_readonly(pda, false));
    }

    Ok(SolanaInstruction {
        program_id,
        data: InterchainSecurityModuleInstruction::VerifyMetadataSpec(
            VerifyMetadataSpecInstruction::new(message_bytes),
        )
        .encode()?,
        accounts,
    })
}

/// Creates a SetDomainIsm instruction.
pub fn set_domain_ism_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    domain: u32,
    ism: IsmNode,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;
    let (domain_pda_key, _) = derive_domain_pda(&program_id, domain);

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::SetDomainIsm { domain, ism }.encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new_readonly(storage_pda_key, false),
            AccountMeta::new(domain_pda_key, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
    })
}

/// Creates a RemoveDomainIsm instruction.
pub fn remove_domain_ism_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    domain: u32,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;
    let (domain_pda_key, _) = derive_domain_pda(&program_id, domain);

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::RemoveDomainIsm { domain }.encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new_readonly(storage_pda_key, false),
            AccountMeta::new(domain_pda_key, false),
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

/// Creates a Pause instruction.
pub fn pause_instruction(
    program_id: Pubkey,
    owner: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::Pause.encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
        ],
    })
}

/// Creates an Unpause instruction.
pub fn unpause_instruction(
    program_id: Pubkey,
    owner: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (storage_pda_key, _) = Pubkey::try_find_program_address(storage_pda_seeds!(), &program_id)
        .ok_or(ProgramError::InvalidSeeds)?;

    Ok(SolanaInstruction {
        program_id,
        data: Instruction::Unpause.encode()?,
        accounts: vec![
            AccountMeta::new(owner, true),
            AccountMeta::new(storage_pda_key, false),
        ],
    })
}
